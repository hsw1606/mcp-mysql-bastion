import { performance } from "perf_hooks";
import { isMultiDbMode } from "./../config/index.js";

import {
  isDDLAllowedForSchema,
  isInsertAllowedForSchema,
  isUpdateAllowedForSchema,
  isDeleteAllowedForSchema,
} from "./permissions.js";
import {
  extractSchemaFromQuery,
  getQueryTypes,
  isUnparseableIntrospection,
  extractQualifiers,
} from "./utils.js";
import {
  isQueryTimeoutError,
  parseExplainPayload,
  renderTimeoutDiagnostic,
} from "./diagnose.js";
import type { CatalogIndexFacts } from "./../catalog/types.js";

import * as mysql2 from "mysql2/promise";
import { log } from "./../utils/index.js";
import {
  ensureTunnel,
  getTunnelFatalError,
  describeTunnel,
} from "./../ssh/tunnel.js";
import {
  mcpConfig as config,
  MYSQL_PROFILE,
  PROFILE_LABEL,
  CODE_BRANCH,
  IS_WRITE_FORBIDDEN_PROFILE,
  MULTI_DB_WRITE_MODE,
  MYSQL_DISABLE_READ_ONLY_TRANSACTIONS,
  MYSQL_DEFAULT_TIMEOUT_SECONDS,
  MYSQL_MAX_TIMEOUT_SECONDS,
  MYSQL_CATALOG_TIMEOUT_SECONDS,
  MAX_RESPONSE_ROWS,
} from "./../config/index.js";

// 멀티 DB 모드에서는 명시적으로 다르게 설정하지 않는 한 읽기 전용 모드를 강제한다
if (isMultiDbMode && !MULTI_DB_WRITE_MODE) {
  log("error", "Multi-DB mode detected - enabling read-only mode for safety");
}

// @INFO: 테스트 모드로 실행 중인지 확인한다
const isTestEnvironment = process.env.NODE_ENV === "test" || process.env.VITEST;

// @INFO: 프로세스를 안전하게 종료한다 (테스트 중에는 종료하지 않는다)
function safeExit(code: number): void {
  if (!isTestEnvironment) {
    process.exit(code);
  } else {
    log("error", `[Test mode] Would have called process.exit(${code})`);
  }
}

// @INFO: MySQL pool을 지연 로딩한다
let poolPromise: Promise<mysql2.Pool> | undefined;

/**
 * 커넥션이 지금 적용받고 있는 세션 제한.
 *
 * `selectLimit: null`은 `sql_select_limit = DEFAULT`, 즉 행 수 상한이 없다는 뜻이다.
 */
interface SessionLimits {
  maxExecutionTimeMs: number;
  selectLimit: number | null;
}

/** 호출이 더 긴 시간을 요구하지 않는 한, 사용자 대상 읽기가 적용받는 제한. */
const READ_LIMITS: SessionLimits = {
  maxExecutionTimeMs: MYSQL_DEFAULT_TIMEOUT_SECONDS * 1_000,
  selectLimit: MAX_RESPONSE_ROWS + 1,
};

/**
 * 카탈로그 자신의 읽기가 적용받는 제한.
 *
 * 행 수 상한은 일부러 두지 않았다. `sql_select_limit`은 사용자 경로와 공유하는 pool의
 * 세션 변수라서, 사용자 쿼리가 남기고 간 상한이 인벤토리 스캔을 조용히 잘라낸다. 그러면
 * 테이블이 MAX_RESPONSE_ROWS보다 많은 스키마는 일부만 담긴 목록으로 캐시되고, 어디에도
 * 그 사실이 남지 않는다. 시간 제한은 유지하되 더 높게 잡는다. 인벤토리 스캔은 대화형
 * 쿼리보다 오래 걸리는 것이 정상이기 때문이다.
 */
const CATALOG_LIMITS: SessionLimits = {
  maxExecutionTimeMs: MYSQL_CATALOG_TIMEOUT_SECONDS * 1_000,
  selectLimit: null,
};

// `pool.getConnection()`이 돌려주는 획득 단위 wrapper보다 오래 사는 물리 커넥션에
// 기록한다. 심볼을 키로 써서 mysql2가 거기 넣어두는 것과 충돌하지 않게 한다.
const SESSION_LIMITS = Symbol.for("mcp-mysql-bastion.sessionLimits");

type LimitCarrier = { [SESSION_LIMITS]?: SessionLimits };

/** promise API wrapper 뒤에 있는 물리 커넥션. */
function limitCarrier(connection: unknown): LimitCarrier {
  const inner = (connection as { connection?: unknown })?.connection;
  return (inner ?? connection) as LimitCarrier;
}

function limitsStatement(limits: SessionLimits): string {
  const selectLimit =
    limits.selectLimit === null ? "DEFAULT" : String(limits.selectLimit);
  return (
    `SET SESSION max_execution_time = ${limits.maxExecutionTimeMs}, ` +
    `SESSION sql_select_limit = ${selectLimit}`
  );
}

function sameLimits(a: SessionLimits | undefined, b: SessionLimits): boolean {
  return (
    a !== undefined &&
    a.maxExecutionTimeMs === b.maxExecutionTimeMs &&
    a.selectLimit === b.selectLimit
  );
}

/**
 * 커넥션을 `desired` 상태로 맞추고, 그 과정에 왕복이 들었는지 알려준다.
 *
 * 커넥션이 이미 그 제한을 달고 있으면 아무 일도 하지 않는다. 흔한 쪽이 그쪽이다.
 * `getPool`이 새 물리 커넥션마다 `READ_LIMITS`를 미리 걸어두므로, 평범한 읽기는 여기서
 * 왕복을 아예 쓰지 않는다.
 *
 * 실패는 로그만 남기고 삼킨다. 두 변수 모두 MySQL 5.7부터 있었으니 이 분기는 우리가
 * 대상으로 삼지 않는 서버에서나 도는 길이고, 거기서 모든 쿼리를 거부하는 것은 제한 없이
 * 한 번 실행하는 것보다 훨씬 나쁜 결과다.
 */
async function applySessionLimits(
  connection: mysql2.PoolConnection,
  desired: SessionLimits,
): Promise<number> {
  const carrier = limitCarrier(connection);
  if (sameLimits(carrier[SESSION_LIMITS], desired)) return 0;
  try {
    await connection.query(limitsStatement(desired));
    carrier[SESSION_LIMITS] = desired;
  } catch (error) {
    delete carrier[SESSION_LIMITS];
    log("error", "Failed to apply session limits; continuing without them:", error);
  }
  return 1;
}

/**
 * 커넥션 pool을 만든다. SSH 터널이 설정돼 있으면 터널을 먼저 연다.
 *
 * `createPool`을 부르기 전에 터널을 await하고, `ensureTunnel()`은 로컬 포트가 실제로 열린
 * 뒤에야 resolve한다. 그래서 아직 아무도 바인드하지 않은 주소를 pool이 받는 일은 없다.
 * 터널이 설정돼 있지 않으면 upstream과 똑같이 동작한다.
 *
 * 여기서 난 실패는 캐시하지 않는다. `poolPromise`를 비우므로, bastion이나 데이터베이스에
 * 다시 닿는 즉시 다음 쿼리가 재시도할 수 있다.
 */
const getPool = (): Promise<mysql2.Pool> => {
  if (!poolPromise) {
    poolPromise = (async (): Promise<mysql2.Pool> => {
      const endpoint = await ensureTunnel();

      // pool이 터널의 loopback 주소를 보게 한다. `socketPath`는 버린다. mysql2가
      // host/port보다 그쪽을 우선하기 때문에, 방금 연 터널을 조용히 우회하게 된다.
      const mysqlConfig = endpoint
        ? (() => {
            const { socketPath: _ignored, ...rest } = config.mysql as Record<
              string,
              unknown
            >;
            return { ...rest, host: endpoint.host, port: endpoint.port };
          })()
        : config.mysql;

      const pool = mysql2.createPool(mysqlConfig as mysql2.PoolOptions);

      // 새 물리 커넥션마다 읽기 제한을 미리 걸어둔다.
      //
      // mysql2는 커넥션을 요청자에게 넘기기 전에 `connection` 이벤트를 낸다. 명령은 큐에
      // 들어간 순서대로 실행되므로, 그 커넥션의 첫 쿼리가 돌 때 이 SET은 이미 끝나 있다.
      // 쿼리마다 비용을 내지 않고 여기서 한 번에 내는 것이 평범한 읽기를 왕복 세 번으로
      // 묶어두는 방법이다. 트랜잭션 시작, 쿼리 실행, 롤백이 그 셋이다. 비용은 커넥션 셋업
      // 안에 떨어지는데, 거기는 이미 TCP·SSH·MySQL 핸드셰이크로 여러 번 왕복하는 구간이다.
      //
      // 이 이벤트는 이 파일의 나머지가 쓰는 promise wrapper가 아니라 콜백 방식 커넥션을
      // 넘겨준다. 그래서 쿼리도 그 방식으로 낸다.
      pool.on("connection", (connection) => {
        const carrier = limitCarrier(connection);
        const raw = connection as unknown as {
          query(sql: string, callback: (error: unknown) => void): void;
        };
        // 응답이 오기 전에 표시한다. 콜백 안에서 하지 않는다. pool은 커넥션을 첫 호출자에게
        // 곧바로 넘기므로, 완료 시점에 쓰는 표시는 그 호출자가 확인할 때 아직 비어 있다.
        // 그러면 호출자가 똑같은 SET을 하나 더 큐에 넣는다. 여기서 중요한 상태는 "큐에
        // 들어갔다"는 것이다. 명령은 순서대로 실행되니, 그 뒤에 보내는 것은 이미 이 제한을
        // 본다.
        carrier[SESSION_LIMITS] = READ_LIMITS;
        raw.query(limitsStatement(READ_LIMITS), (error: unknown) => {
          if (!error) return;
          log("error", "Failed to prime session limits on a new connection:", error);
          delete carrier[SESSION_LIMITS];
        });
      });

      log(
        "info",
        `MySQL pool created successfully (profile: ${PROFILE_LABEL}` +
          (endpoint
            ? `, via ${endpoint.reused ? "reused" : "new"} tunnel ${endpoint.host}:${endpoint.port}`
            : "") +
          ")",
      );
      return pool;
    })();

    poolPromise.catch((error) => {
      log("error", "Error creating MySQL pool:", error);
      poolPromise = undefined;
    });
  }
  return poolPromise;
};

/**
 * 터널이 영구히 끊겼을 때 분명한 메시지로 일찍 거부한다. 이게 없으면 호출자는 대신
 * mysql2가 내는 알 수 없는 ECONNRESET을 본다. 더 이상 아무 데로도 전달하지 않는 loopback
 * 포트를 두드린 결과다.
 */
function assertTunnelHealthy(): void {
  const fatal = getTunnelFatalError();
  if (fatal) throw fatal;
}

/**
 * 모든 도구 응답 앞에 붙는 한 줄 배너. 결과 뒤에 어떤 환경이 있었는지 모호해지지 않게 한다.
 */
function profileBanner(): string {
  const parts = [`profile: ${PROFILE_LABEL}`];
  parts.push(IS_WRITE_FORBIDDEN_PROFILE ? "READ-ONLY (enforced)" : "read-only");
  const db = config.mysql.database || "multi-db";
  parts.push(`database: ${db}`);
  // 도구를 고르는 시점만이 아니라 결과마다 반복한다. 두 환경을 오가며 오래 읽는 세션이
  // 눈앞의 행이 어느 브랜치 것인지 떠올리려고 스크롤을 거슬러 올라갈 일은 없어야 한다.
  if (CODE_BRANCH) parts.push(`code: ${CODE_BRANCH} branch`);
  const tunnel = describeTunnel();
  if (tunnel) parts.push(tunnel);
  return `[${parts.join(" | ")}]`;
}

/**
 * 서버가 자기 몫으로 내는 문장을 위한, 서버 자신의 데이터베이스 경로. 카탈로그의 인벤토리
 * 스캔과 상세 스캔, 그리고 `mysql://tables` 뒤의 resource 핸들러가 여기에 해당한다.
 *
 * 호출자가 코드라면 이쪽을 고른다. 행을 그대로 돌려주고 실패하면 throw하는데, 결과를 실제로
 * *써야 하는* 호출자에게 필요한 것이 그것이다. 그리고 모델에게 줄 답을 다듬는 정책은 하나도
 * 적용하지 않는다. 응답 행 수 상한도, 읽기 전용 트랜잭션도 없다. 그런 것들은 모델이 무엇을
 * 요구할 수 있는지 묶어두려고 있는 장치인데, 서버가 자기가 쓴 질문을 자기에게 던지는 일은
 * 거기에 해당하지 않는다.
 *
 * 호출자가 모델이라면 대신 `executeReadOnlyQuery`를 고른다. 갈림길은 문장이 어떻게 생겼는지가
 * 아니라 *누가 묻는가*다.
 *
 * resource 핸들러를 포함해 모든 호출자가 카탈로그 제한을 적용받는다. 그들의 문장은 서버가
 * 내는 `information_schema` 조회이고, 그 예산은 바로 그런 용도다.
 *
 * pool을 읽기 경로와 공유하므로 제한을 고치는 양쪽 끝이 모두 중요하다. 쿼리 전에 행 수 상한을
 * 푸는 쪽이 결과를 온전하게 지킨다. 잘린 `information_schema` 스캔은 눈에 띄게 망가지는 대신
 * 조용히 틀린 카탈로그를 만들고, 그 아래로는 아무도 차이를 알아채지 못한다. 끝나고 읽기 제한을
 * 되돌리는 쪽은 그 교정 때문에 *다음* 사용자 쿼리가 왕복을 한 번 더 쓰는 일을 막는다.
 */
async function executeQuery<T>(sql: string, params: string[] = []): Promise<T> {
  let connection;
  try {
    assertTunnelHealthy();
    const pool = await getPool();
    connection = await pool.getConnection();
    await applySessionLimits(connection, CATALOG_LIMITS);
    const result = await connection.query(sql, params);
    return (Array.isArray(result) ? result[0] : result) as T;
  } catch (error) {
    log("error", "Error executing query:", error);
    throw error;
  } finally {
    if (connection) {
      try {
        await applySessionLimits(connection, READ_LIMITS);
      } catch (restoreError) {
        // `applySessionLimits`가 쿼리 실패는 이미 삼키므로, 여기 걸리는 것은 예상 밖의
        // 무언가뿐이다. 어느 쪽이든 커넥션은 반납되고, 거기서 지워진 표시 덕분에 다음
        // 호출자가 다시 맞춘다.
        log("error", "Error restoring session limits:", restoreError);
      }
      connection.release();
      log("error", "Connection released");
    }
  }
}

// @INFO: 쓰기 작업을 처리하는 새 함수
async function executeWriteQuery<T>(sql: string): Promise<T> {
  let connection;

  // 이중 방어. `src/config/index.ts`가 쓰기 금지 프로파일에 대해 모든 ALLOW_* 플래그와
  // 스키마 오버라이드를 이미 false로 강제하므로, 이 분기에는 닿지 않아야 한다. 그래도 두는
  // 이유는 나중에 `executeReadOnlyQuery`의 라우팅 로직을 손대더라도 prod로 가는 쓰기 경로가
  // 되살아나지 못하게 하려는 것이다.
  if (IS_WRITE_FORBIDDEN_PROFILE) {
    log(
      "error",
      `Refusing write operation: profile "${MYSQL_PROFILE}" is read-only by policy.`,
    );
    return {
      content: [
        {
          type: "text",
          text:
            `${profileBanner()} Error: write operations are disabled by policy for profile "${MYSQL_PROFILE}". ` +
            `This cannot be enabled through configuration.`,
        },
      ],
      isError: true,
    } as T;
  }

  try {
    assertTunnelHealthy();
    const pool = await getPool();
    connection = await pool.getConnection();
    log("error", "Write connection acquired");

    // 권한 확인에 쓸 스키마를 뽑는다 (필요한 경우)
    const schema = extractSchemaFromQuery(sql);

    // @INFO: 쓰기 작업을 위해 트랜잭션을 시작한다
    await connection.beginTransaction();

    try {
      // @INFO: 쓰기 쿼리를 실행한다
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const response = Array.isArray(result) ? result[0] : result;

      // @INFO: 트랜잭션을 커밋한다
      await connection.commit();

      // @INFO: 작업 종류에 맞춰 응답을 구성한다
      let responseText;

      // 쿼리 종류를 확인한다
      const queryTypes = await getQueryTypes(sql);
      const isUpdateOperation = queryTypes.some((type) =>
        ["update"].includes(type),
      );
      const isInsertOperation = queryTypes.some((type) =>
        ["insert"].includes(type),
      );
      const isDeleteOperation = queryTypes.some((type) =>
        ["delete"].includes(type),
      );
      const isDDLOperation = queryTypes.some((type) =>
        ["create", "alter", "drop", "truncate"].includes(type),
      );

      // @INFO: affectedRows, insertId 등을 가진 ResultSetHeader로 타입을 단언한다
      if (isInsertOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Insert successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Last insert ID: ${resultHeader.insertId}`;
      } else if (isUpdateOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Update successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Changed rows: ${resultHeader.changedRows || 0}`;
      } else if (isDeleteOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Delete successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}`;
      } else if (isDDLOperation) {
        responseText = `DDL operation successful on schema '${schema || "default"}'.`;
      } else {
        responseText = JSON.stringify(response, null, 2);
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
          {
            type: "text",
            text: `Query execution time: ${duration.toFixed(2)} ms`,
          },
        ],
        isError: false,
      } as T;
    } catch (error: unknown) {
      // @INFO: 오류가 나면 롤백한다
      log("error", "Error executing write query:", error);
      await connection.rollback();

      return {
        content: [
          {
            type: "text",
            text: `Error executing write operation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      } as T;
    }
  } catch (error: unknown) {
    log("error", "Error in write operation transaction:", error);
    return {
      content: [
        {
          type: "text",
          text: `Database connection error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    } as T;
  } finally {
    if (connection) {
      connection.release();
      log("error", "Write connection released");
    }
  }
}

/**
 * 타임아웃 진단이 인덱스 지식을 얻어오는 곳.
 *
 * import하지 않고 주입받는다. `src/catalog/collect.ts`가 이미 이 모듈에서 `executeQuery`를
 * import하므로, 카탈로그를 거꾸로 import하면 순환이 닫힌다. 진단 자체도 선택 사항이다.
 * 카탈로그를 끄면 source는 null로 남고 모든 판정이 "undetermined"로 떨어지는데, 무엇이
 * 인덱싱돼 있는지 아무도 모르는 상황에서는 그게 정직한 답이다.
 */
export interface QueryDiagnosticsSource {
  indexFacts(reference: {
    schema: string | null;
    table: string;
  }): CatalogIndexFacts | null;
}

let diagnosticsSource: QueryDiagnosticsSource | null = null;

function setQueryDiagnosticsSource(source: QueryDiagnosticsSource | null): void {
  diagnosticsSource = source;
}

export interface ReadQueryOptions {
  /** 서버 쪽 실행 제한. 설정된 범위 안으로 조정된다. */
  timeoutSeconds?: number;
}

/**
 * 요청받은 timeout을 허용 범위 안으로 끌어온다.
 *
 * 거부하지 않고 조정한다. 이 한계는 쿼리가 폭주하는 것을 막으려고 있고, 100초를 요구하는
 * 호출자는 쓸 수 있는 가장 긴 실행을 원하는 것이지 그 문제로 다투자는 게 아니다.
 */
function clampTimeoutSeconds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return MYSQL_DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.max(Math.floor(requested), 1), MYSQL_MAX_TIMEOUT_SECONDS);
}

/**
 * 취소된 쿼리의 행을 대신할 텍스트를 만든다.
 *
 * 이 서버가 EXPLAIN을 내는 곳은 여기 하나뿐이다. 방금 실패한 그 커넥션에서, 실패한 뒤에만
 * 낸다. 쿼리마다 미리 plan을 받아두면 멀쩡한 쿼리마다 왕복을 하나씩 얹어서 망가진 쿼리의
 * timeout을 아껴주는 셈인데, 순서가 거꾸로다. 비용은 그 비용을 부른 쿼리가 져야 한다.
 *
 * EXPLAIN은 문장을 실행하지 않으므로 timeout을 되풀이할 수 없다. 다만 introspection 가드는
 * 우회한다. 호출자가 보낸 것이 아니라 이 executor 안에서 내기 때문이다. 그리고 plan에는
 * 쿼리가 필터에 쓴 리터럴이 실려 있는데, 그 리터럴은 그것을 쓴 호출자에게 돌아간다. 이
 * 경로 말고 plan이 응답에 실리는 길은 없다.
 */
async function diagnoseTimeout(
  connection: mysql2.PoolConnection,
  sql: string,
  timeoutSeconds: number,
): Promise<string> {
  let plan: unknown | null = null;
  try {
    const explained = await connection.query(`EXPLAIN FORMAT=JSON ${sql}`);
    plan = parseExplainPayload(Array.isArray(explained) ? explained[0] : explained);
  } catch (error) {
    log("error", "Could not EXPLAIN the timed-out query:", error);
  }

  const qualifiers = extractQualifiers(sql);
  const source = diagnosticsSource;
  return renderTimeoutDiagnostic({
    timeoutSeconds,
    maxTimeoutSeconds: MYSQL_MAX_TIMEOUT_SECONDS,
    plan,
    qualifiers,
    // 쿼리가 alias를 썼다면 EXPLAIN도 그 alias로 이름을 부른다. 그래서 plan에 나온 테이블도
    // 조건을 읽을 때 쓴 것과 같은 qualifier 맵으로 풀어낸다.
    lookupIndexes: (name) => {
      if (!source) return null;
      const resolved = qualifiers.get(name.toLowerCase());
      return source.indexFacts(resolved ?? { schema: null, table: name });
    },
  });
}

/**
 * 모델의 데이터베이스 경로. `mysql_query` 도구로 닿는 모든 것이 여기고, 그 밖에는 없다.
 *
 * 문장을 쓴 쪽이 모델이라면 이쪽을 고른다. 쿼리를 실행하는 것 너머로 이 함수가 하는 일은
 * 전부 거기서 따라 나온다. 응답 행 수 상한, 대화형 시간 예산, 읽기 전용 트랜잭션이 그것이다.
 * 서버가 자기를 위해 쓴 문장에 이런 것을 두르는 건 말이 되지 않는다. 그런 문장에는
 * `executeQuery`를 쓴다.
 *
 * 반환 타입도 거기서 따라 나오는데, 새 호출자가 가장 놀랄 만한 부분이 그쪽이다. 이 함수는
 * 행이 아니라 MCP content 블록으로 resolve한다. 거부된 쿼리도 취소된 쿼리도 promise를
 * reject하지 않고 `isError: true`인 content로 돌아온다. 그래서 `content[0]`만 읽어 파싱하는
 * 호출자는 진단을 데이터로 착각한다. resource 핸들러가 이 함수를 부르지 않는 이유가 바로
 * 그것이다.
 *
 * 취소된 문장이 throw하지 않고 resolve하는 것은 의도한 바다. 모델은 곧 재시도할지, 다시 쓸지,
 * 사용자에게 물을지 고르는데, 그 선택은 plan이 있어야만 할 수 있다. 아래 timeout 분기를 보라.
 */
async function executeReadOnlyQuery<T>(
  sql: string,
  options: ReadQueryOptions = {},
): Promise<T> {
  let connection;
  try {
    assertTunnelHealthy();
    // 왜 이 블록을 건너뛰는지, 왜 종류 둘은 제외하는지는 판정 함수의 JSDoc에 적혀 있다.
    // 테스트가 그 함수를 그대로 불러 검사하도록 조건을 여기 두지 않았다.
    const bypassesQueryTypeChecks = isUnparseableIntrospection(sql);

    let queryTypes: string[] = [];
    let schema: string | null = null;
    let isUpdateOperation = false;
    let isInsertOperation = false;
    let isDeleteOperation = false;
    let isDDLOperation = false;

    if (!bypassesQueryTypeChecks) {
      queryTypes = await getQueryTypes(sql);
      schema = extractSchemaFromQuery(sql);
      isUpdateOperation = queryTypes.some((type) => ["update"].includes(type));
      isInsertOperation = queryTypes.some((type) => ["insert"].includes(type));
      isDeleteOperation = queryTypes.some((type) => ["delete"].includes(type));
      isDDLOperation = queryTypes.some((type) =>
        ["create", "alter", "drop", "truncate"].includes(type),
      );
    }

    // 스키마별 권한을 확인한다
    if (isInsertOperation && !isInsertAllowedForSchema(schema)) {
      log(
        "error",
        `INSERT operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_INSERT_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: INSERT operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_INSERT_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isUpdateOperation && !isUpdateAllowedForSchema(schema)) {
      log(
        "error",
        `UPDATE operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_UPDATE_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: UPDATE operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_UPDATE_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isDeleteOperation && !isDeleteAllowedForSchema(schema)) {
      log(
        "error",
        `DELETE operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_DELETE_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: DELETE operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_DELETE_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isDDLOperation && !isDDLAllowedForSchema(schema)) {
      log(
        "error",
        `DDL operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_DDL_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: DDL operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_DDL_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    // 허용된 쓰기 작업은 executeWriteQuery로 넘긴다
    if (
      (isInsertOperation && isInsertAllowedForSchema(schema)) ||
      (isUpdateOperation && isUpdateAllowedForSchema(schema)) ||
      (isDeleteOperation && isDeleteAllowedForSchema(schema)) ||
      (isDDLOperation && isDDLAllowedForSchema(schema))
    ) {
      return executeWriteQuery(sql);
    }

    // 읽기 전용 작업은 원래 로직을 그대로 이어간다
    const pool = await getPool();
    connection = await pool.getConnection();
    log("error", "Read-only connection acquired");

    // 왕복 횟수는 어림잡지 않고 센다. 이 경로가 이렇게 생긴 이유 자체가 그 예산이기
    // 때문이다. 한 번 왕복할 때마다 SSH 터널을 건너는데, stage에서 재보니 대략 137 ms다.
    // 그러니 아래 세 번이 빠른 쿼리 비용의 대부분이다.
    const timeoutSeconds = clampTimeoutSeconds(options.timeoutSeconds);
    let roundTrips = await applySessionLimits(connection, {
      maxExecutionTimeMs: timeoutSeconds * 1_000,
      selectLimit: MAX_RESPONSE_ROWS + 1,
    });

    // 한 문장으로 트랜잭션을 열면서 접근 모드까지 선언한다. 세션 기본값을 바꾼 뒤
    // 트랜잭션을 시작하면 두 문장이 든다. 모드를 트랜잭션에 묶어두면 나중에 되돌릴 것도
    // 없다. 롤백이 끝나는 순간 모드도 끝난다.
    if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
      await connection.query("START TRANSACTION READ ONLY");
    } else {
      log("info", "Read-only transactions disabled via MYSQL_DISABLE_READ_ONLY_TRANSACTIONS=true");
      await connection.beginTransaction();
    }
    roundTrips += 1;

    try {
      // 쿼리를 실행한다. 멀티 DB 모드에서는 USE 문을 따로 다뤄야 할 수도 있다
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      roundTrips += 1;
      let rows: unknown = Array.isArray(result) ? result[0] : result;

      // 읽기 전용이므로 트랜잭션을 롤백한다
      await connection.rollback();
      roundTrips += 1;
      log("info", `Read query completed in ${roundTrips} DB round trips`);

      //
      // `sql_select_limit`은 자체 LIMIT이 없는 쿼리의 전송량을 묶는다. 더 큰 LIMIT을 단
      // 쿼리는 그 세션 변수를 통째로 무시하므로, 어느 쪽이든 여기서 같은 자리를 자른다.
      let truncated = false;
      if (Array.isArray(rows) && rows.length > MAX_RESPONSE_ROWS) {
        truncated = true;
        rows = rows.slice(0, MAX_RESPONSE_ROWS);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(rows, null, 2),
          },
          // 경고는 타이밍 줄보다 앞, 자기 블록에 따로 둔다. 그래야 잘린 결과를 온전한
          // 결과로 읽는 일이 없다. 조용히 자르면 모델이 그보다 많은 행을 가진 테이블을 두고
          // "5000개다"라고 답하게 된다.
          ...(truncated
            ? [
                {
                  type: "text",
                  text:
                    `[TRUNCATED] Only the first ${MAX_RESPONSE_ROWS.toLocaleString("en-US")} rows are shown; ` +
                    `the query matched more. This is NOT the complete result - do not count, sum, or ` +
                    `conclude anything about totals from it. Add a narrower WHERE, an aggregate ` +
                    `(COUNT/SUM/GROUP BY), or paginate with ORDER BY + LIMIT/OFFSET. Raising the cap ` +
                    `is an operator change (MYSQL_MAX_RESPONSE_ROWS), not something to retry around.`,
                },
              ]
            : []),
          {
            type: "text",
            text: `Query execution time: ${duration.toFixed(2)} ms`,
          },
        ],
        isError: false,
      } as T;
    } catch (error) {
      // 쿼리 오류가 나면 트랜잭션을 롤백한다
      log("error", "Error executing read-only query:", error);
      await connection.rollback();

      // MySQL이 제한 초과로 취소한 문장은 이 경로가 예외를 올리는 대신 답으로 돌려주는
      // 유일한 오류다. 모델은 곧 재시도할지, 다시 쓸지, 사용자에게 물을지 정해야 하는데
      // 그 판단은 plan이 있어야만 할 수 있다. 없으면 모델이 직접 plan을 받아오면서 왕복을
      // 한 번 더 쓰고, 최악의 경우 같은 쿼리를 한 번 더 돌린다. 위의 롤백은 다른 실패와
      // 똑같이 먼저 일어난다.
      if (isQueryTimeoutError(error)) {
        const diagnostic = await diagnoseTimeout(connection, sql, timeoutSeconds);
        log(
          "info",
          // 카운터는 예외를 던진 문장 앞에서 멈췄다. 취소된 쿼리, 롤백, 진단용 EXPLAIN
          // 한 번을 더한다.
          `Read query cancelled at ${timeoutSeconds}s after ${roundTrips + 3} DB round trips (including one EXPLAIN)`,
        );
        return {
          content: [{ type: "text", text: diagnostic }],
          isError: true,
        } as T;
      }
      throw error;
    }
  } catch (error) {
    // 어떤 오류가 나든 반드시 롤백한다. 되돌릴 트랜잭션 모드는 없다.
    // `START TRANSACTION READ ONLY`는 접근 모드를 방금 롤백이 끝낸 그 트랜잭션에
    // 묶어두기 때문이다.
    log("error", "Error in read-only query transaction:", error);
    try {
      if (connection) {
        await connection.rollback();
      }
    } catch (cleanupError) {
      // 정리 중에 난 오류는 무시한다
      log("error", "Error during cleanup:", cleanupError);
    }
    throw error;
  } finally {
    if (connection) {
      connection.release();
      log("error", "Read-only connection released");
    }
  }
}

export {
  profileBanner,
  isTestEnvironment,
  safeExit,
  executeQuery,
  getPool,
  executeWriteQuery,
  executeReadOnlyQuery,
  setQueryDiagnosticsSource,
  clampTimeoutSeconds,
  poolPromise,
};
