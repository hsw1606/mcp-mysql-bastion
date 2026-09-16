import * as dotenv from "dotenv";
import * as fs from "fs";
import { AppSchemaEntry, SchemaPermissions } from "../types/index.js";

/**
 * `SCHEMA_*_PERMISSIONS`를 스키마별 플래그로 파싱한다. 형식은
 * `"schema1:true,schema2:false"`.
 *
 * 예전에는 `src/utils/index.ts`에 있었다. 그러다 이 파일이 그것을 import하고
 * `log()`는 `ENABLE_LOGGING`을 직접 읽는 구조가 되어, "환경 변수는 config에서만
 * 읽는다"를 지키려면 반드시 풀어야 할 순환이 생겼다. 환경 변수 하나의 문법을
 * 해석하는 함수이므로 원래 자리가 여기다.
 */
function parseSchemaPermissions(permissionsString?: string): SchemaPermissions {
  const permissions: SchemaPermissions = {};

  if (!permissionsString) {
    return permissions;
  }

  for (const pair of permissionsString.split(",")) {
    const [schema, value] = pair.split(":");
    if (schema && value) {
      permissions[schema.trim()] = value.trim() === "true";
    }
  }

  return permissions;
}

/**
 * SSL 연결에 쓸 파일(인증서, 키, CA)을 읽고 검증한다.
 * @param filePath - SSL 파일 경로 (PEM 형식)
 * @param label - 오류 메시지에 쓸 사람이 읽는 이름 (예: "CA certificate", "client certificate")
 * @returns 파일 내용을 담은 Buffer
 * @throws 파일이 없거나 비어 있거나 읽지 못하면 Error
 */
function readSSLFile(filePath: string, label: string): Buffer {
  try {
    // 파일이 있고 읽을 수 있는지 확인한다
    if (!fs.existsSync(filePath)) {
      throw new Error(`SSL ${label} file not found: ${filePath}`);
    }

    // 파일을 읽는다
    const data = fs.readFileSync(filePath);

    // 기본 검증 — 내용이 비어 있지 않은지 본다
    if (data.length === 0) {
      throw new Error(`SSL ${label} file is empty: ${filePath}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      // 우리가 만든 오류는 그대로 다시 던진다
      if (error.message.startsWith('SSL ')) {
        throw error;
      }
      // 그 밖의 오류(권한 거부 등)는 감싸서 던진다
      throw new Error(`Failed to read SSL ${label}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * SSL 연결에 쓸 CA 인증서 파일을 읽고 검증한다.
 * @param filePath - CA 인증서 파일 경로 (PEM 형식)
 * @returns 인증서 내용을 담은 Buffer
 * @throws 파일이 없거나 비어 있거나 읽지 못하면 Error
 */
function readCACertificate(filePath: string): Buffer {
  return readSSLFile(filePath, 'CA certificate');
}

/**
 * MCP 클라이언트에 알리는 버전. 이 포크가 갈라져 나온 원본 프로젝트와는 따로
 * 관리한다.
 */
export const MCP_VERSION = "1.0.0";

/**
 * 프로필의 환경 변수를 읽어들인다.
 *
 * 우선순위 순으로 세 가지 방식이 있다:
 *   1. `MYSQL_ENV_FILE` — 그 파일만 읽고 다른 것은 보지 않는다.
 *   2. `MYSQL_PROFILE`이 있으면 — `.env.<profile>`이 있을 때만 읽고, `.env`로는
 *      일부러 넘어가지 않는다. 프로필 파일이 언급하지도 않은 키를(예: 남아 있던
 *      `ALLOW_DELETE_OPERATION=true`) 범용 `.env`에서 물려받으면 안 되기 때문이다.
 *   3. 둘 다 없으면 — 원본 동작대로 그냥 `.env`를 읽는다.
 *
 * 어느 경우든 `dotenv`는 이미 export된 변수를 건드리지 않는다. 그래서 `bin/`의
 * 래퍼 스크립트가 최종 결정권을 갖는다.
 */
const envFileFromProfile = process.env.MYSQL_PROFILE
  ? `.env.${process.env.MYSQL_PROFILE.trim().toLowerCase()}`
  : undefined;
const explicitEnvFile = process.env.MYSQL_ENV_FILE?.trim();

if (explicitEnvFile) {
  const result = dotenv.config({ path: explicitEnvFile });
  if (result.error) {
    throw new Error(
      `MYSQL_ENV_FILE="${explicitEnvFile}" could not be loaded: ${result.error.message}`,
    );
  }
} else if (envFileFromProfile) {
  if (fs.existsSync(envFileFromProfile)) {
    dotenv.config({ path: envFileFromProfile });
  }
} else {
  dotenv.config();
}

/**
 * 이 서버 인스턴스가 바라보는 환경. 도구 설명과 모든 쿼리 응답에 드러내서,
 * 운영자가 프로덕션 결과를 스테이징 결과로 착각할 일이 없게 한다.
 */
export const MYSQL_PROFILE = (process.env.MYSQL_PROFILE ?? "").trim().toLowerCase();

/**
 * 쓰기 플래그를 코드 차원에서 거부하는 프로필.
 *
 * 환경 변수로 뒤집을 수 있는 기본값이 아니다 — 프로필이 여기 걸리면 아래에서
 * `ALLOW_*`와 `SCHEMA_*_PERMISSIONS`를 강제로 끈다. env 파일, 셸 export, MCP
 * 클라이언트 설정을 어떻게 조합해도 이 서버가 프로덕션에 쓰게 만들 수 없도록
 * 하려는 것이다.
 */
const WRITE_FORBIDDEN_PROFILES = new Set(["prod", "production"]);

export const IS_WRITE_FORBIDDEN_PROFILE =
  WRITE_FORBIDDEN_PROFILES.has(MYSQL_PROFILE);

/** 도구 설명과 쿼리 응답에 쓰는 라벨. */
export const PROFILE_LABEL = MYSQL_PROFILE
  ? MYSQL_PROFILE.toUpperCase()
  : "UNSPECIFIED";

/**
 * 이 환경의 데이터와 짝이 맞는 코드가 있는 Git 브랜치.
 *
 * 쿼리를 해석하려면 그 행을 쓴 코드가 거의 항상 필요한데, 브랜치를 잘못 고르면
 * 조용히 틀린다 — stage 스키마를 `main` 기준으로 읽으면 체크아웃이 어긋난 것이
 * 아니라 컬럼이 없는 것처럼 보인다. 그래서 브랜치를 여기 선언하고 도구 설명과
 * 모든 응답 배너에서 거듭 알린다.
 *
 * `MYSQL_CODE_BRANCH`가 있으면 그 값이 이긴다. 없으면 프로필별 관례 매핑을 쓰고,
 * 모르는 프로필이면 아무 말도 하지 않는다.
 */
const DEFAULT_CODE_BRANCH: Readonly<Record<string, string>> = {
  stage: "develop",
  staging: "develop",
  dev: "develop",
  develop: "develop",
  prod: "main",
  production: "main",
};

export const CODE_BRANCH: string =
  process.env.MYSQL_CODE_BRANCH?.trim() || DEFAULT_CODE_BRANCH[MYSQL_PROFILE] || "";

/**
 * `MYSQL_APP_SCHEMAS`를 애플리케이션-스키마 맵으로 파싱한다.
 *
 * 항목은 `;`나 줄바꿈으로 나눈다. 쉼표가 아닌 이유는 설명을 문장처럼 쓸 수 있게
 * 하기 위해서다. 각 항목은 `app:schema`이고 세 번째 필드를 덧붙일 수 있다:
 * `app:schema:무엇이 들어 있는지`. 앞의 두 콜론만 구분자로 쓰므로 설명 안에
 * 콜론이 들어가도 된다.
 *
 * 같은 app이 여러 번 나올 수 있다. 한 서비스가 스키마를 여럿 갖는 경우가 실제로
 * 있고(테넌트별 스키마와 공용 스키마를 함께 쓰는 식), 마지막 것만 남기면 모델에
 * 필요한 스키마가 가려진다. app과 schema 쌍이 똑같이 겹칠 때만 실수로 본다.
 *
 * 형식이 틀린 항목은 예외를 던지지 않고 알린 뒤 건너뛴다. 한 줄의 오타로 서버가
 * 죽으면 안 되고, 나머지 매핑은 여전히 쓸모가 있다.
 */
function parseAppSchemas(raw: string | undefined): AppSchemaEntry[] {
  if (!raw) return [];
  const entries: AppSchemaEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(/[;\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const firstColon = trimmed.indexOf(":");
    if (firstColon === -1) {
      console.error(
        `[config] ignoring MYSQL_APP_SCHEMAS entry "${trimmed}": expected "app:schema" or "app:schema:description".`,
      );
      continue;
    }
    const app = trimmed.slice(0, firstColon).trim();
    const rest = trimmed.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    const schema = (secondColon === -1 ? rest : rest.slice(0, secondColon)).trim();
    const description =
      secondColon === -1 ? undefined : rest.slice(secondColon + 1).trim() || undefined;

    if (!app || !schema) {
      console.error(
        `[config] ignoring MYSQL_APP_SCHEMAS entry "${trimmed}": app and schema must both be non-empty.`,
      );
      continue;
    }
    const pair = `${app.toLowerCase()}\u0000${schema.toLowerCase()}`;
    if (seen.has(pair)) {
      console.error(
        `[config] MYSQL_APP_SCHEMAS repeats "${app}:${schema}"; keeping the first.`,
      );
      continue;
    }
    seen.add(pair);
    entries.push({ app, schema, description });
  }
  return entries;
}

/**
 * 선언된 애플리케이션-스키마 맵. 비어 있어도 정상적인 설정이다 — 그러면 서버는
 * 이 기능이 생기기 전과 똑같이 동작한다.
 */
export const APP_SCHEMAS: readonly AppSchemaEntry[] = parseAppSchemas(
  process.env.MYSQL_APP_SCHEMAS,
);

/** 로컬 스키마 catalog. 준비에 실패하면 catalog만 꺼진다. */
export const MYSQL_CATALOG_ENABLED =
  process.env.MYSQL_CATALOG_ENABLED !== "false";
export const MYSQL_CATALOG_PATH =
  process.env.MYSQL_CATALOG_PATH?.trim() || undefined;

function parseCatalogTtl(raw: string | undefined): number {
  if (!raw) return 24;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(
      `[config] ignoring MYSQL_CATALOG_TTL_HOURS="${raw}": expected a positive number; using 24.`,
    );
    return 24;
  }
  return value;
}

export const MYSQL_CATALOG_TTL_HOURS = parseCatalogTtl(
  process.env.MYSQL_CATALOG_TTL_HOURS,
);

/** Git 접근은 catalog의 문서 단계에서 더해진다. 경로가 비어 있어도 된다. */
export const MYSQL_DOCS_REPO = process.env.MYSQL_DOCS_REPO?.trim() || undefined;

/**
 * 진단 로깅 스위치. `src/utils/index.ts`의 `log()`가 이 값만 본다.
 *
 * `1`도 켠 것으로 받는 것은 README가 그렇게 약속했기 때문이다.
 */
export const ENABLE_LOGGING =
  process.env.ENABLE_LOGGING === "true" || process.env.ENABLE_LOGGING === "1";

/**
 * 테스트 러너 안에서 도는가.
 *
 * `src/db/index.ts`의 `safeExit`가 이 값으로 `process.exit`를 가른다. 테스트가
 * 워커를 통째로 죽이면 남은 경우들이 실행되지 못한다. vitest는 `NODE_ENV`를
 * 건드리지 않고 `VITEST`만 세우는 실행 경로가 있어서 둘 다 본다.
 */
export const IS_TEST_ENVIRONMENT =
  process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);

/**
 * MCP 클라이언트에 알리는 버전.
 *
 * `npm_package_version`은 npm 스크립트로 실행할 때만 채워진다. MCP 클라이언트는
 * `dist/index.js`를 직접 실행하므로 그때는 빌드된 `MCP_VERSION`으로 간다.
 */
export const PACKAGE_VERSION =
  process.env.npm_package_version?.trim() || MCP_VERSION;

// @INFO: 데이터베이스가 제대로 잡히도록 환경 설정을 보정한다
if (process.env.NODE_ENV === "test" && !process.env.MYSQL_DB) {
  process.env.MYSQL_DB = "mcp_test_db"; // @INFO: 테스트에서 쓸 데이터베이스 이름을 확보한다
}

/**
 * 프로필이 고정한 기본 스키마. 없으면 다중 DB 모드다.
 *
 * 공백만 든 값은 없는 것으로 본다. 예전에는 `isMultiDbMode`만 trim하고 풀 옵션의
 * `database`는 원문을 썼다. `MYSQL_DB=" "`이면 서버는 다중 DB 모드라고 말하면서
 * mysql2에는 이름이 " "인 스키마를 넘겼다.
 */
export const MYSQL_DB = process.env.MYSQL_DB?.trim() || undefined;

// 쓰기 작업 플래그 (전역 기본값).
//
// `envFlag`는 원본 동작이고, `writeFlag`는 그 위에 프로필 거부권을 얹는다. 서버의
// 모든 쓰기 경로가 이 상수들을 읽으므로, 여기서 false로 고정하면 그것만으로 해당
// 프로필은 읽기 전용이 된다 — `process.env.ALLOW_*`를 보는 곳은 여기 말고 없다.
const envFlag = (name: string): boolean => process.env[name] === "true";
const writeFlag = (name: string): boolean =>
  IS_WRITE_FORBIDDEN_PROFILE ? false : envFlag(name);

if (IS_WRITE_FORBIDDEN_PROFILE) {
  const requested = [
    "ALLOW_INSERT_OPERATION",
    "ALLOW_UPDATE_OPERATION",
    "ALLOW_DELETE_OPERATION",
    "ALLOW_DDL_OPERATION",
    "MULTI_DB_WRITE_MODE",
  ].filter(envFlag);
  if (requested.length > 0) {
    // 시끄럽게 알리되 죽이지는 않는다: 플래그는 이미 무력해졌다. 여기서 종료하면
    // 무해한 설정 실수가 쓸 수 없는 서버로 바뀐다.
    console.error(
      `[config] profile "${MYSQL_PROFILE}" is read-only by policy; ignoring ${requested.join(", ")}.`,
    );
  }
}

export const ALLOW_INSERT_OPERATION = writeFlag("ALLOW_INSERT_OPERATION");
export const ALLOW_UPDATE_OPERATION = writeFlag("ALLOW_UPDATE_OPERATION");
export const ALLOW_DELETE_OPERATION = writeFlag("ALLOW_DELETE_OPERATION");
export const ALLOW_DDL_OPERATION = writeFlag("ALLOW_DDL_OPERATION");

/**
 * 다중 DB 쓰기용 탈출구. 쓰기 금지 프로필에서는 이것도 거부한다. `src/db/index.ts`가
 * 읽는 값이며, 그 파일은 나머지 설정은 `process.env`에서 직접 본다.
 */
export const MULTI_DB_WRITE_MODE = writeFlag("MULTI_DB_WRITE_MODE");

// 트랜잭션 모드 제어
export const MYSQL_DISABLE_READ_ONLY_TRANSACTIONS =
  process.env.MYSQL_DISABLE_READ_ONLY_TRANSACTIONS === "true";

/**
 * 양의 정수 환경 변수를 읽고, 값이 없거나 쓸 수 없는 숫자면 `fallback`을 쓴다.
 * `parseCatalogTtl`과 같은 방식이다: 알리고 계속 간다, 절대 던지지 않는다. 상한을
 * 잘못 입력했다고 안 뜨는 서버가 기본값으로 도는 서버보다 나쁘다.
 */
function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    console.error(
      `[config] ignoring ${name}="${raw}": expected a positive integer; using ${fallback}.`,
    );
    return fallback;
  }
  return Math.floor(value);
}

/**
 * 포트 환경 변수를 읽는다. 값이 없거나 못 쓸 값이면 `undefined`를 주고, 호출자는
 * 자기 다음 후보(`~/.ssh/config` alias, 그다음 기본값)로 넘어간다.
 *
 * 예전에는 `src/ssh/tunnel.ts`가 같은 일을 하면서 **던졌다**. 그래서 같은
 * `MYSQL_PORT` 하나를 두고 두 정책이 공존했다 — config는 3306으로 물러나며
 * 계속 간다고 알리고, 터널 경로는 프로세스를 죽였다. `MYSQL_SSH_ENABLED=true`인
 * 프로필에서는 알림이 무의미했다. 알리는 쪽으로 통일한다. "설정 오류 하나로
 * 서버를 죽이지 않는다"가 이 저장소의 규칙이고, 포트는 그 예외가 아니다.
 *
 * `parsePositiveInt`와 따로 두는 이유는 0 때문이다. `MYSQL_SSH_LOCAL_PORT=0`은
 * "OS가 빈 포트를 고르게 하라"는 뜻으로 README에 적힌 유효한 값이다.
 */
function parsePortEnv(name: string, raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `[config] ignoring ${name}="${raw}": expected an integer between 0 and 65535.`,
    );
    return undefined;
  }
  return port;
}

/**
 * 읽기 쿼리의 서버 쪽 실행 상한, 초 단위.
 *
 * 모든 읽기는 `max_execution_time` 아래에서 돈다. 그래서 인덱스를 타지 못하는
 * 쿼리는 MCP 클라이언트가 포기할 때까지 도구 호출을 붙잡고 있지 않고 취소된다.
 * 기본값이 짧은 것은 의도한 것이다: 이건 대화형 도구고 사람이 답을 기다린다.
 *
 * `mysql_query`는 호출마다 `timeout_seconds`로 상한을 올릴 수 있지만
 * `MYSQL_MAX_TIMEOUT_SECONDS`까지만 가능하다. 이 천장은 우리가 겨냥하는 모든 MCP
 * 클라이언트의 기본 도구 timeout보다 낮다. 그래야 실패를 알리는 쪽이 늘 서버가
 * 된다 — 클라이언트가 먼저 포기하면 모델에는 진단할 단서가 하나도 남지 않는다.
 */
export const MYSQL_MAX_TIMEOUT_SECONDS = parsePositiveInt(
  "MYSQL_MAX_TIMEOUT_SECONDS",
  process.env.MYSQL_MAX_TIMEOUT_SECONDS,
  30,
);

/**
 * 호출자가 `timeout_seconds`를 주지 않았을 때 쓰는 기본값. 천장에 맞춰 잘라내므로
 * `MYSQL_MAX_TIMEOUT_SECONDS`를 10 아래로 낮추면 기본값도 함께 내려간다. 어떤
 * 호출로도 요청할 수 없는 기본값이 남는 일을 막는다.
 */
export const MYSQL_DEFAULT_TIMEOUT_SECONDS = Math.min(
  10,
  MYSQL_MAX_TIMEOUT_SECONDS,
);

/**
 * catalog가 스스로 도는 `information_schema` 읽기의 시간 상한.
 *
 * 사용자용 상한과 나눠 둔 것은 둘의 성격이 다르기 때문이다. 사용자 쿼리는 대화형이라
 * 빨리 실패해야 하지만, 인벤토리 스캔은 백그라운드에서 선언된 모든 스키마를 한 번에
 * 훑으므로 더 기다릴 값어치가 있다. 행 상한은 공유하지 *않는다* — `MAX_RESPONSE_ROWS`를
 * 보라.
 */
export const MYSQL_CATALOG_TIMEOUT_SECONDS = parsePositiveInt(
  "MYSQL_CATALOG_TIMEOUT_SECONDS",
  process.env.MYSQL_CATALOG_TIMEOUT_SECONDS,
  60,
);

/**
 * 읽기 한 번이 호출자에게 돌려줄 수 있는 최대 행 수.
 *
 * 쿼리 상한이 아니라 응답 상한이다 — 이름이 `RESULT`가 아니라 `RESPONSE`인 이유다.
 * 호출자의 컨텍스트로 넘어가는 양을 제한하므로, 자르는 자리는 문장이 아니라 응답을
 * 조립하는 지점이다. 자기 LIMIT을 더 크게 들고 온 쿼리는 `sql_select_limit`을 아예
 * 무시하지만, 나가는 길에는 여전히 잘린다. 세션은 이 수보다 1 크게 돌려서, 그 한 줄이
 * 잘림이 일어났다는 증거가 되게 한다.
 *
 * 설정할 수 있게 둔 것은 이 값이 지키는 대상이 호출자의 컨텍스트 창이고, 프로필은
 * 클라이언트 하나를 겨냥해 쓰이기 때문이다. 큰 컨텍스트를 가진 클라이언트에 프로필을
 * 맞추는 운영자는 이 기본값이 알 수 없는 사정을 안다. 일부러 운영자만 쥐는 손잡이로
 * 뒀다 — 어떤 도구 인자로도 호출자가 자기 상한을 올릴 수 없다.
 */
export const MAX_RESPONSE_ROWS = parsePositiveInt(
  "MYSQL_MAX_RESPONSE_ROWS",
  process.env.MYSQL_MAX_RESPONSE_ROWS,
  5000,
);

/**
 * 동시에 열어 두는 MySQL 커넥션 수.
 *
 * 터널을 쓰면 이 커넥션들은 SSH 세션 하나 위의 독립된 채널이 된다. 그래서 값을
 * 올리는 비용은 bastion 쪽 채널 몇 개이지 SSH 핸드셰이크가 아니다. 기본값이 작은
 * 것은 이 서버를 쓰는 쪽이 모델 하나이고, 그 모델은 도구 호출을 한 번에 하나씩
 * 하기 때문이다.
 */
export const MYSQL_POOL_SIZE = parsePositiveInt(
  "MYSQL_POOL_SIZE",
  process.env.MYSQL_POOL_SIZE,
  10,
);

/** 풀이 꽉 찼을 때 대기열에 쌓아 둘 요청 수. */
export const MYSQL_QUEUE_LIMIT = parsePositiveInt(
  "MYSQL_QUEUE_LIMIT",
  process.env.MYSQL_QUEUE_LIMIT,
  100,
);

/** TCP·핸드셰이크까지 포함한 접속 제한 시간(ms). */
export const MYSQL_CONNECT_TIMEOUT = parsePositiveInt(
  "MYSQL_CONNECT_TIMEOUT",
  process.env.MYSQL_CONNECT_TIMEOUT,
  10000,
);

/**
 * MySQL 접속 대상.
 *
 * 세 값 모두 풀 옵션(`mcpConfig.mysql`)과 SSH 터널의 forwarding 대상이 함께
 * 본다. 두 경로가 각자 `process.env`를 읽던 시절에는 기본값이 갈라졌다 —
 * 한쪽은 `127.0.0.1`, 다른 쪽은 `localhost`, 못 쓸 포트에서는 한쪽은 `NaN`,
 * 다른 쪽은 예외. 읽는 자리를 하나로 묶으면 갈라질 자리가 없어진다.
 *
 * `MYSQL_HOST`는 일부러 기본값을 씌우지 않는다. 터널 경로는 "값이 없다"를
 * 설정 부족으로 보고 무엇이 빠졌는지 알려야 하기 때문이다. 직접 접속의 기본값
 * `127.0.0.1`은 아래 `mcpConfig`가 씌운다.
 */
export const MYSQL_SOCKET_PATH =
  process.env.MYSQL_SOCKET_PATH?.trim() || undefined;
export const MYSQL_HOST = process.env.MYSQL_HOST?.trim() || undefined;
export const MYSQL_PORT = parsePositiveInt(
  "MYSQL_PORT",
  process.env.MYSQL_PORT,
  3306,
);

/** 직접 접속에서 `MYSQL_HOST`가 비었을 때 쓰는 주소. README의 표와 같은 값이다. */
export const DEFAULT_MYSQL_HOST = "127.0.0.1";

/**
 * SSL 설정. 경로와 스위치만 export한다.
 *
 * 파일 **내용**은 아래 `mcpConfig.mysql.ssl`에만 담긴다. 진단 로그처럼 설정을
 * 사람에게 보여 주는 자리는 경로만 쓴다 — 거기서 `mcpConfig`를 펼치면 클라이언트
 * 개인 키가 통째로 stderr에 찍힌다.
 */
export const MYSQL_SSL_ENABLED = process.env.MYSQL_SSL === "true";
export const MYSQL_SSL_REJECT_UNAUTHORIZED =
  process.env.MYSQL_SSL_REJECT_UNAUTHORIZED === "true";
export const MYSQL_SSL_CA_PATH = process.env.MYSQL_SSL_CA?.trim() || undefined;
export const MYSQL_SSL_CERT_PATH =
  process.env.MYSQL_SSL_CERT?.trim() || undefined;
export const MYSQL_SSL_KEY_PATH = process.env.MYSQL_SSL_KEY?.trim() || undefined;

/** 그 밖의 mysql2 전달 옵션. */
export const MYSQL_TIMEZONE = process.env.MYSQL_TIMEZONE?.trim() || undefined;
export const MYSQL_DATE_STRINGS = process.env.MYSQL_DATE_STRINGS === "true";
export const MYSQL_BIG_NUMBER_STRINGS =
  process.env.MYSQL_BIG_NUMBER_STRINGS === "true";

/** bastion 터널을 열지 여부. `src/ssh/tunnel.ts`가 이 값으로 갈린다. */
export const SSH_ENABLED = process.env.MYSQL_SSH_ENABLED === "true";

/**
 * 우리 터널을 새로 열지 않고, 이미 listen 중인 forward에 붙는다.
 *
 * 기본값은 꺼짐이고, 이는 의도한 선택이다. 재사용하면 이 프로세스의 DB 접속이
 * 터널을 연 다른 프로세스의 수명에 묶인다. MCP 클라이언트는 서버를 수시로 켜고
 * 끄므로 터널 주인이 먼저 종료되는 일이 잦고, 그때 빌려 쓰던 쪽의 커넥션은 쿼리
 * 도중 PROTOCOL_CONNECTION_LOST로 끊긴다. 우리 터널을 직접 소유하면 SSH 세션
 * 하나를 더 쓰는 대신 이 실패 유형이 통째로 사라진다.
 *
 * 외부에서 관리하는 forward(오래 떠 있는 `ssh -L`)를 공유할 의도가 있을 때만 켠다.
 */
export const SSH_REUSE_EXISTING =
  process.env.MYSQL_SSH_REUSE_EXISTING === "true";

/**
 * 터널 설정의 원자재.
 *
 * 해석은 `src/ssh/tunnel.ts`의 `resolveTunnelConfig()`가 한다 — 여기 없는 값을
 * `~/.ssh/config` alias로 채우고, `~`를 펼치고, 그래도 빈 자리가 남으면 무엇이
 * 없는지 알린다. 이 파일은 읽기만 맡는다.
 */
export const SSH_CONFIG_HOST =
  process.env.MYSQL_SSH_CONFIG_HOST?.trim() || undefined;
export const SSH_HOST = process.env.MYSQL_SSH_HOST?.trim() || undefined;
export const SSH_USER = process.env.MYSQL_SSH_USER?.trim() || undefined;
export const SSH_PORT = parsePortEnv("MYSQL_SSH_PORT", process.env.MYSQL_SSH_PORT);
export const SSH_PRIVATE_KEY_PATH =
  process.env.MYSQL_SSH_PRIVATE_KEY_PATH?.trim() || undefined;
export const SSH_PASSPHRASE =
  process.env.MYSQL_SSH_PASSPHRASE?.trim() || undefined;
export const SSH_LOCAL_PORT = parsePortEnv(
  "MYSQL_SSH_LOCAL_PORT",
  process.env.MYSQL_SSH_LOCAL_PORT,
);

// 스키마별 권한.
//
// 전역 플래그를 스키마 단위로 *덮어쓰는* 값이라, 쓰기 금지 프로필에서는 이것도
// 비워야 한다. 그러지 않으면 `SCHEMA_UPDATE_PERMISSIONS=foo:true`가 방금 전역
// 거부권으로 닫은 문을 다시 연다.
const schemaPermissions = (name: string): SchemaPermissions =>
  IS_WRITE_FORBIDDEN_PROFILE ? {} : parseSchemaPermissions(process.env[name]);

export const SCHEMA_INSERT_PERMISSIONS: SchemaPermissions =
  schemaPermissions("SCHEMA_INSERT_PERMISSIONS");
export const SCHEMA_UPDATE_PERMISSIONS: SchemaPermissions =
  schemaPermissions("SCHEMA_UPDATE_PERMISSIONS");
export const SCHEMA_DELETE_PERMISSIONS: SchemaPermissions =
  schemaPermissions("SCHEMA_DELETE_PERMISSIONS");
export const SCHEMA_DDL_PERMISSIONS: SchemaPermissions =
  schemaPermissions("SCHEMA_DDL_PERMISSIONS");

// 다중 DB 모드인지 확인한다 (특정 DB를 지정하지 않은 경우)
export const isMultiDbMode = !MYSQL_DB;

/**
 * mysql2에 그대로 넘기는 풀 옵션.
 *
 * 이 객체에는 `mysql` 하나만 있다. 예전에는 서버 이름과 전송 방식을 함께 들고
 * 있었는데, 서버 이름은 `index.ts`가 직접 적고 전송은 stdio 하나뿐이라 둘 다
 * 읽는 곳이 없었다.
 */
const MYSQL_PASS = process.env.MYSQL_PASS ?? "";

export const mcpConfig = {
  mysql: {
    // Unix 소켓이 있으면 그것을 쓰고, 없으면 host/port를 쓴다.
    // 터널을 열면 `getPool`이 socketPath를 버리고 loopback 주소로 갈아끼운다.
    ...(MYSQL_SOCKET_PATH
      ? { socketPath: MYSQL_SOCKET_PATH }
      : {
          host: MYSQL_HOST || DEFAULT_MYSQL_HOST,
          port: MYSQL_PORT,
        }),
    user: process.env.MYSQL_USER?.trim() || "root",
    password: MYSQL_PASS,
    database: MYSQL_DB, // 다중 DB 모드를 위해 database가 undefined인 것을 허용한다
    connectionLimit: MYSQL_POOL_SIZE,
    waitForConnections: true,
    queueLimit: MYSQL_QUEUE_LIMIT,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: MYSQL_CONNECT_TIMEOUT,
    authPlugins: {
      mysql_clear_password: () => () => Buffer.from(MYSQL_PASS),
    },
    ...(MYSQL_SSL_ENABLED
      ? {
          ssl: {
            rejectUnauthorized: MYSQL_SSL_REJECT_UNAUTHORIZED,
            // CA 인증서가 있으면 더한다
            ...(MYSQL_SSL_CA_PATH
              ? { ca: readCACertificate(MYSQL_SSL_CA_PATH) }
              : {}),
            // mTLS용 클라이언트 인증서가 있으면 더한다
            ...(MYSQL_SSL_CERT_PATH
              ? { cert: readSSLFile(MYSQL_SSL_CERT_PATH, 'client certificate') }
              : {}),
            // mTLS용 클라이언트 개인 키가 있으면 더한다
            ...(MYSQL_SSL_KEY_PATH
              ? { key: readSSLFile(MYSQL_SSL_KEY_PATH, 'client private key') }
              : {}),
          },
        }
      : {}),
    // 날짜/시간 처리를 위한 타임존 설정
    ...(MYSQL_TIMEZONE ? { timezone: MYSQL_TIMEZONE } : {}),
    // 날짜 값을 JavaScript Date 객체 대신 문자열로 돌려준다
    ...(MYSQL_DATE_STRINGS ? { dateStrings: true } : {}),
    // 정밀도 손실을 막으려고 BIGINT/DECIMAL 값을 문자열로 돌려준다
    // snowflake ID(19자리)를 쓰는 테이블에는 필수다. Number.MAX_SAFE_INTEGER(2^53-1)를 넘기 때문이다
    ...(MYSQL_BIG_NUMBER_STRINGS
      ? { supportBigNumbers: true, bigNumberStrings: true }
      : {}),
  },
};

/**
 * 설정에 적힌 접속 대상을 사람이 읽는 한 줄로 만든다. 비밀값은 담지 않는다.
 *
 * 터널을 연 뒤의 **실제** endpoint는 여기서 알 수 없다. 그쪽은
 * `src/db/index.ts`의 `describeConnection()`이 맡는다.
 */
export function describeConfiguredTarget(): string {
  return MYSQL_SOCKET_PATH
    ? `socket: ${MYSQL_SOCKET_PATH}`
    : `${MYSQL_HOST || DEFAULT_MYSQL_HOST}:${MYSQL_PORT}`;
}

export { readCACertificate, readSSLFile };
