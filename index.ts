#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./src/utils/index.js";
import type { TableRow, ColumnRow } from "./src/types/index.js";
import {
  ALLOW_DELETE_OPERATION,
  ALLOW_DDL_OPERATION,
  ALLOW_INSERT_OPERATION,
  ALLOW_UPDATE_OPERATION,
  SCHEMA_DELETE_PERMISSIONS,
  SCHEMA_DDL_PERMISSIONS,
  SCHEMA_INSERT_PERMISSIONS,
  SCHEMA_UPDATE_PERMISSIONS,
  isMultiDbMode,
  mcpConfig as config,
  MCP_VERSION as version,
  MYSQL_PROFILE,
  PROFILE_LABEL,
  IS_WRITE_FORBIDDEN_PROFILE,
  APP_SCHEMAS,
  CODE_BRANCH,
  MYSQL_CATALOG_ENABLED,
  MYSQL_CATALOG_PATH,
  MYSQL_CATALOG_TTL_HOURS,
  MYSQL_DOCS_REPO,
  MYSQL_DEFAULT_TIMEOUT_SECONDS,
  MYSQL_MAX_TIMEOUT_SECONDS,
  MAX_RESPONSE_ROWS,
} from "./src/config/index.js";
import {
  catalogIdentity,
  SchemaCatalog,
  type CatalogForgetScope,
} from "./src/catalog/index.js";
import {
  safeExit,
  getPool,
  executeQuery,
  executeReadOnlyQuery,
  setQueryDiagnosticsSource,
  clampTimeoutSeconds,
  poolPromise,
  profileBanner,
} from "./src/db/index.js";
import {
  SSH_ENABLED,
  describeTunnel,
  ensureTunnel,
  resolveTunnelConfig,
  stopTunnel,
} from "./src/ssh/tunnel.js";

import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';


log("info", `Starting MySQL MCP server v${version}...`);

// 도구 설명에 multi-DB 모드와 스키마별 권한을 반영한다.
// npm_package_version은 npm 스크립트로 실행할 때만 설정된다. MCP 클라이언트는
// dist/index.js를 직접 실행하므로, 그럴 때는 빌드된 버전 값으로 대신한다.
const toolVersion = `MySQL MCP Server [v${process.env.npm_package_version ?? version}]`;

// 클라이언트가 도구 설명에서 남겨 두는 글자 수. Claude Code 기준값이다. 이 값은
// 프로토콜로 협상하지도 않고 누구도 되돌려 알려 주지 않는다. 그래서 우리가 아는
// 가장 작은 상한에 맞춰 만든다.
const TOOL_DESCRIPTION_LIMIT = 2048;
let baseToolDescription = `[${toolVersion}] Run SQL queries against the ${PROFILE_LABEL} MySQL database`;

// 기능 설명보다 환경 이름을 먼저 적는다. 모델이 도구를 고르기 전에 확실히 읽는 것은
// 도구 설명뿐이다. 그래서 "지금 프로덕션을 상대하고 있다"는 사실은 여기에 있어야 한다.
if (MYSQL_PROFILE) {
  baseToolDescription += IS_WRITE_FORBIDDEN_PROFILE
    ? ` — ENVIRONMENT: ${PROFILE_LABEL}, STRICTLY READ-ONLY (writes are refused by policy)`
    : ` — ENVIRONMENT: ${PROFILE_LABEL}`;
}

if (isMultiDbMode) {
  baseToolDescription += " (Multi-DB mode enabled)";
}

if (
  ALLOW_INSERT_OPERATION ||
  ALLOW_UPDATE_OPERATION ||
  ALLOW_DELETE_OPERATION ||
  ALLOW_DDL_OPERATION
) {
  // 쓰기 작업이 하나 이상 켜져 있다
  baseToolDescription += " with support for:";

  if (ALLOW_INSERT_OPERATION) {
    baseToolDescription += " INSERT,";
  }

  if (ALLOW_UPDATE_OPERATION) {
    baseToolDescription += " UPDATE,";
  }

  if (ALLOW_DELETE_OPERATION) {
    baseToolDescription += " DELETE,";
  }

  if (ALLOW_DDL_OPERATION) {
    baseToolDescription += " DDL,";
  }

  // 끝의 쉼표를 지우고 READ 작업을 덧붙인다
  baseToolDescription =
    baseToolDescription.replace(/,$/, "") + " and READ operations";

  if (
    Object.keys(SCHEMA_INSERT_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_UPDATE_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_DELETE_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_DDL_PERMISSIONS).length > 0
  ) {
    baseToolDescription += " (Schema-specific permissions enabled)";
  }
} else {
  // 읽기 작업만 허용한다
  baseToolDescription += " (READ-ONLY)";
}

// 아래 내용은 모델이 탐색용 왕복을 한 번 덜 하도록 넣었다. 도구 설명은 첫 호출 전에
// 읽힌다. 여기 적히지 않은 것은 쿼리로 찾아야 하는데, `SHOW DATABASES`를 던지고 추측
// 으로 메우는 방식은 느린 데다 틀리기도 쉽다.

// 두 상한을 모두 앞에서 밝힌다. 둘 다 쿼리를 어떻게 써야 하는지를 바꾸는데, 모델은
// 쿼리를 쓰기 전에만 이 글을 읽을 수 있기 때문이다. 잘림 경고를 보고서야 행 수 상한을
// 알았다면, 그 쿼리는 이미 잘못된 방식으로 던져진 뒤다.
//
// 반면 취소된 쿼리를 다음에 어떻게 할지는 여기 적지 않는다. 중단 보고서가 그것을
// 말해 주고 `timeout_seconds` 인자도 말해 주며, 둘 다 이 예산을 쓰지 않는다. 쿼리를
// *쓰는 방식*을 바꾸는 내용만 여기에 자리를 얻는다.
baseToolDescription +=
  `\n\nLIMITS: every read is cancelled after ${MYSQL_DEFAULT_TIMEOUT_SECONDS}s ` +
  `(raise per call with timeout_seconds, up to ${MYSQL_MAX_TIMEOUT_SECONDS}) and returns at most ` +
  `${MAX_RESPONSE_ROWS.toLocaleString("en-US")} rows. Aggregate in SQL rather than pulling rows to count them.`;

if (CODE_BRANCH) {
  baseToolDescription +=
    `\n\nCODE REVISION: this database matches the \`${CODE_BRANCH}\` branch. ` +
    `Read entities, migrations, and queries from that branch when correlating code with data.`;
}

if (APP_SCHEMAS.length > 0) {
  baseToolDescription +=
    "\n\nAPP -> SCHEMA (authoritative — use these directly; do not run SHOW DATABASES " +
    "or search information_schema to find a schema):";
  for (const entry of APP_SCHEMAS) {
    baseToolDescription +=
      `\n  - ${entry.app} -> ${entry.schema}` +
      (entry.description ? ` — ${entry.description}` : "");
  }
  baseToolDescription +=
    "\nQualify every table with its schema (schema.table). Any schema not listed here is " +
    "either absent from this environment or not owned by an application.";
  const needsQuoting = APP_SCHEMAS.find(
    (entry) => !/^[A-Za-z0-9_$]+$/.test(entry.schema),
  );
  if (needsQuoting) {
    baseToolDescription +=
      `\nA schema name that is not a bare identifier must be backtick-quoted, ` +
      `e.g. SELECT ... FROM \`${needsQuoting.schema}\`.some_table.`;
  }
}

// 읽기 전용 모드인지 판단한다 (쓰기 작업이 하나도 켜지지 않은 상태)
const isReadOnly = !(
  ALLOW_INSERT_OPERATION ||
  ALLOW_UPDATE_OPERATION ||
  ALLOW_DELETE_OPERATION ||
  ALLOW_DDL_OPERATION
);

const mysqlCatalogTool = {
  name: "mysql_catalog",
  description:
    "Read the local schema catalog without rediscovering database metadata. " +
    "Use map for the app/schema overview, search to find tables or known columns, " +
    "describe before writing SQL, and docs_list/docs_read to inspect domain documents. " +
    "Use link or unlink to record the model's document decision. " +
    "Use note to save a table memo or alias, and forget to clear one catalog scope. " +
    "Use refresh when cached metadata contradicts what a query actually returned, " +
    "or right after a migration: added columns and indexes raise no error, so " +
    "nothing else invalidates them.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "map",
          "search",
          "describe",
          "docs_list",
          "docs_read",
          "link",
          "unlink",
          "note",
          "forget",
          "refresh",
        ],
        description: "Catalog operation to perform",
      },
      q: {
        type: "string",
        description: "Keyword for search",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum search results (default 20)",
      },
      table: {
        type: "string",
        description:
          "Qualified schema.table name for describe, or for unlink. note and " +
          "forget take the same name as target instead.",
      },
      schema: {
        type: "string",
        description:
          "Declared schema name for docs_list. Results are narrowed to the " +
          "documents under the app directory declared for that schema; the " +
          "response says so and reports how many were left out.",
      },
      path: {
        type: "string",
        description: "Cataloged model.md path for docs_read",
      },
      target: {
        type: "string",
        description:
          'Qualified schema.table for note or forget. For refresh: "schema.table" for one table\'s ' +
          'columns, indexes and foreign keys; a declared schema name for the ' +
          'table inventory; "docs" to re-read the document ref after a git ' +
          "fetch. Omit it to refresh the inventory and the documents together.",
      },
      text: {
        type: "string",
        maxLength: 1000,
        description: "Table memo to add with note; use either text or alias",
      },
      alias: {
        type: "string",
        maxLength: 200,
        description: "Alternative table name to add with note; use either alias or text",
      },
      scope: {
        type: "string",
        enum: ["notes", "aliases", "usage", "joins", "metadata"],
        description:
          "What forget clears for one table. metadata is lazily recollected; " +
          "document decisions use unlink instead.",
      },
      links: {
        type: "array",
        description: "Table/document decisions to record in one call",
        items: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Qualified schema.table name",
            },
            doc: {
              type: "string",
              description: "Cataloged model.md path",
            },
          },
          required: ["table", "doc"],
        },
      },
    },
    required: ["action"],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
    title: "MySQL Schema Catalog",
  },
};

/**
 * 한 번만 선언해 두고 `mysql_query`의 두 등록 지점이 함께 쓴다.
 *
 * 이 도구는 두 번 알려진다 — 서버의 `capabilities`에서 한 번, `tools/list` 핸들러에서
 * 다시 한 번 — 그리고 클라이언트마다 둘 중 어느 쪽을 읽는지가 다르다. 같은 리터럴을
 * 두 벌 두면, 한쪽만 고치는 순간 어떤 클라이언트는 다른 클라이언트가 보는 인자를
 * 보지 못하게 된다.
 */
const mysqlQueryInputSchema = {
  type: "object" as const,
  properties: {
    sql: {
      type: "string",
      description: "The SQL query to execute",
    },
    timeout_seconds: {
      type: "integer",
      minimum: 1,
      maximum: MYSQL_MAX_TIMEOUT_SECONDS,
      description:
        `Server-side execution limit in seconds (default ${MYSQL_DEFAULT_TIMEOUT_SECONDS}, ` +
        `maximum ${MYSQL_MAX_TIMEOUT_SECONDS}; out-of-range values are clamped). ` +
        `Raise it only when a cancelled query's plan looked sound and the query was merely slow. ` +
        `A query the plan shows scanning a whole table does not finish sooner with more time.`,
    },
  },
  required: ["sql"],
};

// @INFO: 설정값을 디버그 로그로 남긴다
// FIXME: 아래 MYSQL_SOCKET_PATH/HOST/PORT/SSL* 는 config가 이미 읽어
// mcpConfig.mysql로 만들어 둔 값의 두 번째 사본이다. 두 곳이 어긋나면 로그가
// 실제 접속과 다른 것을 말한다. mcpConfig에서 받아 쓰도록 바꾼다
// (AGENTS.md의 "환경 변수는 src/config/index.ts에서만 읽는다").
log(
  "info",
  "MySQL Configuration:",
  JSON.stringify(
    {
      ...(process.env.MYSQL_SOCKET_PATH
        ? {
            socketPath: process.env.MYSQL_SOCKET_PATH,
            connectionType: "Unix Socket",
          }
        : {
            host: process.env.MYSQL_HOST || "127.0.0.1",
            port: process.env.MYSQL_PORT || "3306",
            connectionType: "TCP/IP",
          }),
      user: config.mysql.user,
      password: config.mysql.password ? "******" : "not set",
      database: config.mysql.database || "MULTI_DB_MODE",
      ssl: process.env.MYSQL_SSL === "true" ? "enabled" : "disabled",
      sslCA: process.env.MYSQL_SSL_CA || "not set",
      sslCert: process.env.MYSQL_SSL_CERT || "not set",
      sslKey: process.env.MYSQL_SSL_KEY || "not set",
      multiDbMode: isMultiDbMode ? "enabled" : "disabled",
      profile: PROFILE_LABEL,
      writePolicy: IS_WRITE_FORBIDDEN_PROFILE
        ? "read-only (enforced by profile)"
        : isReadOnly
          ? "read-only"
          : "writes enabled",
      sshTunnel: SSH_ENABLED ? describeTunnel() : "disabled",
    },
    null,
    2,
  ),
);

/**
 * MCP 서버 인스턴스를 만들고 요청 핸들러를 연결한다.
 *
 * 이 포크는 stdio 전송만 제공하므로 세션마다 넘겨야 할 설정이 없다. 프로파일은
 * 프로세스가 시작되기 전에 환경에서 이미 정해진다.
 */
export default function createMcpServer() {
  const mysqlSettings = config.mysql as Record<string, unknown>;
  const catalogTarget = SSH_ENABLED
    ? (() => {
        const tunnel = resolveTunnelConfig();
        return JSON.stringify(["tcp", tunnel.remoteHost, tunnel.remotePort]);
      })()
    : typeof mysqlSettings.socketPath === "string"
      ? JSON.stringify(["unix", mysqlSettings.socketPath])
      : JSON.stringify([
          "tcp",
          String(mysqlSettings.host ?? "127.0.0.1"),
          Number(mysqlSettings.port ?? 3306),
        ]);
  const identity = catalogIdentity({
    profile: MYSQL_PROFILE,
    target: catalogTarget,
    user: String(mysqlSettings.user ?? ""),
    customPath: MYSQL_CATALOG_PATH,
  });
  // MYSQL_APP_SCHEMAS가 스캔 범위 선언이고, 그 바깥은 아무것도 수집하지 않는다(D-1).
  // 하나도 선언되지 않으면 카탈로그는 스캔할 것이 없다. 그런데도 켜 두면 mysql_catalog를
  // 광고하고 모델에게 describe를 부르라고 해 놓고는, 모든 호출에 빈 map이나 오류로
  // 답하게 된다. 이럴 때는 꺼 두는 쪽이 정직하다.
  const noDeclaredSchemas = APP_SCHEMAS.length === 0;
  if (noDeclaredSchemas && MYSQL_CATALOG_ENABLED) {
    console.error(
      "[catalog] disabled: MYSQL_APP_SCHEMAS declares no schema, so there is " +
        "nothing to catalog. Declare the app -> schema map to enable it.",
    );
  }
  const catalog = new SchemaCatalog({
    enabled: MYSQL_CATALOG_ENABLED && !noDeclaredSchemas,
    profile: MYSQL_PROFILE || "default",
    fingerprint: identity.fingerprint,
    filePath: identity.filePath,
    ttlHours: MYSQL_CATALOG_TTL_HOURS,
    appSchemas: APP_SCHEMAS,
    docsRepo: MYSQL_DOCS_REPO ?? null,
    docsRef: CODE_BRANCH ? `origin/${CODE_BRANCH}` : null,
    defaultSchema:
      typeof mysqlSettings.database === "string"
        ? mysqlSettings.database
        : null,
  });
  // 읽기 경로는 쿼리가 이미 취소된 뒤에만 카탈로그에 무엇이 색인돼 있는지 묻는다.
  // 한쪽이 다른 쪽을 import 하게 두지 않고 여기서 카탈로그를 넘겨 주면, 의존 방향을
  // `src/catalog` -> `src/db` 한 쪽으로만 유지할 수 있다.
  setQueryDiagnosticsSource({
    indexFacts: (reference) => catalog.indexFacts(reference),
  });

  // 클라이언트는 도구 설명에 상한을 두고, 아무 말 없이 뒤쪽을 잘라 낸다. Claude Code는
  // 2048자를 남긴다. 그 값을 되읽어 올 방법이 없으므로 설명의 두 부분을 우리 쪽에서
  // 예산으로 나눠 써야 한다. 그러지 않으면 쿼리가 성공할수록 길어지는 자주 쓰는 테이블
  // 목록이, 글을 쓴 지 몇 주 뒤에 어떤 프로파일을 상한 너머로 밀어낸다. 기본 설명이
  // 우선이고 시작 시점에 고정된다. 카탈로그 꼬리말은 남은 만큼만 가져간다.
  if (baseToolDescription.length > TOOL_DESCRIPTION_LIMIT) {
    // `log`을 거치지 않는다. 설명이 상한을 넘겼다는 것은 진단 정보가 아니라 설정 오류이고,
    // 이 상황에 걸리는 프로파일은 대개 ENABLE_LOGGING을 끈 채 돌아가는 쪽이다.
    console.error(
      `[warn] tool description is ${baseToolDescription.length} characters before the ` +
        `catalog tail; clients keep ${TOOL_DESCRIPTION_LIMIT} and silently drop the rest. ` +
        `Shorten MYSQL_APP_SCHEMAS descriptions, or the text in index.ts.`,
    );
  }
  const mysqlQueryDescription = (): string =>
    baseToolDescription +
    catalog.toolDescriptionSuffix(
      TOOL_DESCRIPTION_LIMIT - baseToolDescription.length,
    );
  const loadResourceTables = async (): Promise<TableRow[]> => {
    if (catalog.isEnabled()) {
      try {
        const cached = await catalog.listTables();
        if (cached.length > 0) return cached;
      } catch (error) {
        console.error(
          `[catalog] table resource fallback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // 카탈로그가 꺼져 있거나 아직 비어 있을 때를 위한 호환 경로다.
    //
    // `executeQuery`를 쓰는 것은 서버가 제 몫으로 묻고 있기 때문이다. 읽기 경로는 모델에게
    // 답한다. 행 수를 제한하고, 행 대신 MCP 콘텐츠 블록을 돌려주며, 구문이 취소되면
    // 예외를 던지는 대신 정상적으로 resolve 한다 — 테이블 목록이 필요한 호출자에게는
    // 어느 것도 쓸모가 없다. 여기서 도는 것은 카탈로그가 돌리는 것과 같은 인스턴스 전체
    // 스캔이고, 같은 제한 아래에서 돈다.
    //
    // 행 수 상한이 없다는 점은 따로 변호할 만하다. 응답 상한은 그 밖의 모든 곳에 적용되기
    // 때문이다. 이유는 셋이고, 각각만으로도 충분하다.
    //
    //   - 여기서 자르면 잘랐다고 알릴 수가 없다. 잘림은 읽기 경로가 `[TRUNCATED]` 블록을
    //     덧붙여 보고한다. 이 실행기는 행만 그대로 돌려주므로 그 말을 얹을 자리가 없고,
    //     잘린 목록이 온전한 목록처럼 읽힌다.
    //   - 카탈로그와 어긋난다. `listTables`는 저장된 스냅샷을 상한 없이 펼친다. 폴백에만
    //     상한을 두면 같은 리소스가 인벤토리 스캔이 끝났는지에 따라 완전성을 다르게
    //     보고한다 — 어느 쪽이든 일관된 것보다 나쁘다.
    //   - 이 행들은 결과 집합이 아니라 목록 자체다. 상한은 쿼리 결과가 모델의 컨텍스트를
    //     밀어내지 않게 하려고 있다. 이 목록에서 빠진 테이블은 클라이언트가 아예 제시하지
    //     않고 `mysql://tables/{name}`으로 물어볼 수도 없게 된다. 분량이 아니라 닿는 범위를
    //     줄이는 일이다.
    return await executeQuery<TableRow[]>(`
      SELECT
        table_name as name,
        table_schema as \`database\`,
        table_comment as description,
        table_rows as rowCount,
        data_length as dataSize,
        index_length as indexSize,
        create_time as createTime,
        update_time as updateTime
      FROM
        information_schema.tables
      WHERE
        table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY
        table_schema, table_name
    `);
  };

  // 서버 인스턴스를 만든다
  const server = new Server(
    {
      name: "MySQL MCP Server",
      version: process.env.npm_package_version || version,
    },
    {
      capabilities: {
        resources: {},
        tools: {
          ...(catalog.isEnabled() ? { listChanged: true } : {}),
          mysql_query: {
            description: mysqlQueryDescription(),
            inputSchema: mysqlQueryInputSchema,
            annotations: {
              readOnlyHint: isReadOnly,
              idempotentHint: isReadOnly,
              destructiveHint: !isReadOnly,
              openWorldHint: false,
              title: "MySQL Query",
            },
          },
          ...(catalog.isEnabled()
            ? {
                mysql_catalog: {
                  description: mysqlCatalogTool.description,
                  inputSchema: mysqlCatalogTool.inputSchema,
                  annotations: mysqlCatalogTool.annotations,
                },
              }
            : {}),
        },
      },
    },
  );

  // 리소스 요청 핸들러를 등록한다
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      log("info", "Handling ListResourcesRequest");
      // FIXME: 위 설정 로그와 같은 문제 — MYSQL_SOCKET_PATH/HOST/PORT를 직접
      // 읽는다. mcpConfig.mysql에서 받아 쓴다.
      const connectionInfo = process.env.MYSQL_SOCKET_PATH
        ? `socket: ${process.env.MYSQL_SOCKET_PATH}`
        : `host: ${process.env.MYSQL_HOST || "localhost"}, port: ${
            process.env.MYSQL_PORT || 3306
          }`;
      log("info", `Connection info: ${connectionInfo}`);

      // 보통은 시작 시 모아 둔 인벤토리가 데이터베이스를 읽지 않고 이 요청에 답한다.
      // 카탈로그가 꺼져 있거나 비어 있으면 원래의 리소스 동작을 그대로 따른다.
      const tables = await loadResourceTables();
      log("info", `Found ${tables.length} tables`);

      // 테이블마다 리소스를 만든다
      const resources = tables.map((table) => ({
        uri: catalog.isEnabled()
          ? `mysql://tables/${encodeURIComponent(table.database)}/${encodeURIComponent(table.name)}`
          : `mysql://tables/${table.name}`,
        name: table.name,
        title: `${table.database}.${table.name}`,
        description:
          table.description ||
          `Table ${table.name} in database ${table.database}`,
        mimeType: "application/json",
      }));

      // 테이블 목록 자체를 가리키는 리소스를 추가한다
      resources.push({
        uri: "mysql://tables",
        name: "Tables",
        title: "MySQL Tables",
        description: "List of all MySQL tables",
        mimeType: "application/json",
      });

      // 선언된 app -> schema 매핑. 도구 설명 대신 리소스를 읽는 클라이언트를 위한 것이다.
      if (APP_SCHEMAS.length > 0) {
        resources.push({
          uri: "mysql://schemas",
          name: "App schemas",
          title: "Application to schema map",
          description: `Which schema each application owns in ${PROFILE_LABEL}`,
          mimeType: "application/json",
        });
      }

      return { resources };
    } catch (error) {
      log("error", "Error in ListResourcesRequest handler:", error);
      throw error;
    }
  });

  // 리소스 읽기 요청 핸들러를 등록한다
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      log("info", "Handling ReadResourceRequest:", request.params.uri);

      // app -> schema 매핑은 데이터가 아니라 설정이다. 데이터베이스를 건드리지 않고 답하며,
      // 아래의 테이블 이름 파싱이 "schemas"를 테이블로 오해하기 전에 처리한다.
      if (request.params.uri === "mysql://schemas") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  profile: PROFILE_LABEL,
                  ...(CODE_BRANCH ? { codeBranch: CODE_BRANCH } : {}),
                  apps: APP_SCHEMAS,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // 카탈로그가 꺼져 있어도 여기서 답한다. 이 URI는 조건 없이 목록에 오르고 끝에
      // 슬래시가 없다. 그래서 아래 파싱은 이것을 스키마 없는 테이블 이름 "tables"로 읽고,
      // 테이블 목록을 요청한 호출자에게 `information_schema.tables`의 컬럼을 돌려준다.
      // 카탈로그가 꺼져 있거나 비어 있는 경우는 `loadResourceTables`가 이미 처리한다.
      if (request.params.uri === "mysql://tables") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(await loadResourceTables(), null, 2),
            },
          ],
        };
      }

      // 통용되는 URI 형태가 둘이다. 카탈로그 이전 서버가 쓰던 `mysql://tables/<table>`과
      // 카탈로그가 쓰는 `mysql://tables/<schema>/<table>`. 세그먼트를 뒤에서부터 무작정
      // 꺼내지 말고 접두사를 기준으로 파싱한다. 그래야 세그먼트가 하나인 형태에서
      // "tables"라는 글자를 스키마 이름으로 오해하지 않는다.
      let dbName: string | null = null;
      let tableName: string | undefined;

      if (request.params.uri.startsWith("mysql://tables/")) {
        const parts = request.params.uri
          .slice("mysql://tables/".length)
          .split("/")
          .map(decodeURIComponent);
        dbName = parts.length >= 2 ? parts[0] : null;
        tableName = parts.length >= 2 ? parts[1] : parts[0];

        if (catalog.isEnabled()) {
          try {
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: "application/json",
                  text: await catalog.describe(
                    dbName ? `${dbName}.${tableName}` : tableName,
                  ),
                },
              ],
            };
          } catch (error) {
            // 카탈로그가 아직 이 테이블을 모른다 — 인벤토리 스캔이 진행 중이거나,
            // MYSQL_APP_SCHEMAS가 선언하지 않은 스키마다. 이미 리소스로 목록에 올린
            // 이상 계속 읽을 수 있어야 한다. 예전 서버가 그랬듯 information_schema로
            // 넘어간다.
            log(
              "info",
              `[catalog] describe fallback for ${request.params.uri}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } else {
        const uriParts = request.params.uri.split("/");
        tableName = uriParts.pop();
        dbName = uriParts.length > 0 ? uriParts.pop() ?? null : null;
      }

      if (!tableName) {
        throw new Error(`Invalid resource URI: ${request.params.uri}`);
      }

      // 스키마 정보까지 포함하도록 쿼리를 손본다
      let columnsQuery =
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?";
      let queryParams = [tableName as string];

      if (dbName) {
        columnsQuery += " AND table_schema = ?";
        queryParams.push(dbName);
      }

      // 여기서 `executeQuery`를 쓰는 것은 호출자가 모델이 아니라 서버이기 때문이다.
      // 서버에는 행 자체가 필요한데, 읽기 경로는 MCP 콘텐츠 블록으로 답한다.
      const results = (await executeQuery(
        columnsQuery,
        queryParams,
      )) as ColumnRow[];

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      log("error", "Error in ReadResourceRequest handler:", error);
      throw error;
    }
  });

  // 도구 호출 핸들러를 등록한다
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      log("info", "Handling CallToolRequest:", request.params.name);
      if (request.params.name === "mysql_catalog") {
        if (!catalog.isEnabled()) throw new Error("The schema catalog is disabled.");
        const args = request.params.arguments ?? {};
        const action = args.action;
        let text: string;
        if (action === "map") {
          text = await catalog.map();
        } else if (action === "search") {
          if (typeof args.q !== "string" || !args.q.trim()) {
            throw new Error('mysql_catalog search requires a non-empty "q".');
          }
          text = await catalog.search(
            args.q,
            typeof args.limit === "number" ? args.limit : undefined,
          );
        } else if (action === "describe") {
          if (typeof args.table !== "string" || !args.table.trim()) {
            throw new Error('mysql_catalog describe requires "table" as schema.table.');
          }
          text = await catalog.describe(args.table);
        } else if (action === "docs_list") {
          if (typeof args.schema !== "string" || !args.schema.trim()) {
            throw new Error('mysql_catalog docs_list requires "schema".');
          }
          text = await catalog.docsList(args.schema);
        } else if (action === "docs_read") {
          if (typeof args.path !== "string" || !args.path.trim()) {
            throw new Error('mysql_catalog docs_read requires "path".');
          }
          text = await catalog.docsRead(args.path);
        } else if (action === "link") {
          if (
            !Array.isArray(args.links) ||
            !args.links.every(
              (link) =>
                link &&
                typeof link === "object" &&
                typeof link.table === "string" &&
                typeof link.doc === "string",
            )
          ) {
            throw new Error(
              'mysql_catalog link requires "links" as [{table, doc}, ...].',
            );
          }
          text = await catalog.link(args.links);
        } else if (action === "unlink") {
          if (typeof args.table !== "string" || !args.table.trim()) {
            throw new Error('mysql_catalog unlink requires "table" as schema.table.');
          }
          text = await catalog.unlink(args.table);
        } else if (action === "note") {
          if (typeof args.target !== "string" || !args.target.trim()) {
            throw new Error('mysql_catalog note requires "target" as schema.table.');
          }
          const hasText =
            typeof args.text === "string" && args.text.trim().length > 0;
          const hasAlias =
            typeof args.alias === "string" && args.alias.trim().length > 0;
          if (hasText === hasAlias) {
            throw new Error(
              'mysql_catalog note requires exactly one non-empty "text" or "alias".',
            );
          }
          text = await catalog.note(args.target, {
            ...(hasText ? { text: args.text as string } : {}),
            ...(hasAlias ? { alias: args.alias as string } : {}),
          });
        } else if (action === "forget") {
          if (typeof args.target !== "string" || !args.target.trim()) {
            throw new Error('mysql_catalog forget requires "target" as schema.table.');
          }
          const scopes = new Set<CatalogForgetScope>([
            "notes",
            "aliases",
            "usage",
            "joins",
            "metadata",
          ]);
          if (
            typeof args.scope !== "string" ||
            !scopes.has(args.scope as CatalogForgetScope)
          ) {
            throw new Error(
              'mysql_catalog forget requires "scope" as notes, aliases, usage, joins, or metadata.',
            );
          }
          text = await catalog.forget(
            args.target,
            args.scope as CatalogForgetScope,
          );
        } else if (action === "refresh") {
          if (args.target !== undefined && typeof args.target !== "string") {
            throw new Error('mysql_catalog refresh takes "target" as a string.');
          }
          text = await catalog.refresh(args.target);
        } else {
          throw new Error(`Unknown mysql_catalog action: ${String(action)}`);
        }
        return {
          content: [
            { type: "text", text: profileBanner() },
            { type: "text", text },
          ],
          isError: false,
        };
      }

      if (request.params.name !== "mysql_query") {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const sql = request.params.arguments?.sql as string;
      // 검증해서 거절하지 않고 범위 안으로 맞춘다. 이 인자는 폭주하는 쿼리를 묶어 두는
      // 장치다. 범위를 벗어난 숫자 하나로 호출을 거절하면, 스키마에 이미 적혀 있는 한계를
      // 알아내려고 사용자가 왕복을 한 번 더 해야 한다.
      const timeoutSeconds = clampTimeoutSeconds(
        request.params.arguments?.timeout_seconds,
      );
      const references = catalog.prepareQuery(sql);
      let result: {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      try {
        result = await executeReadOnlyQuery(sql, { timeoutSeconds });
      } catch (error) {
        catalog.afterQuery(references, { content: [], isError: true }, error);
        throw error;
      }
      const documentGuidance = result.isError
        ? null
        : catalog.queryDocumentGuidance(references);
      catalog.afterQuery(references, result);

      // 성공이든 거절이든 모든 결과 앞에 환경 배너를 붙인다. 그래야 stage의 답을
      // prod의 답으로 착각하는 일이 생기지 않는다.
      return {
        ...result,
        content: [
          { type: "text", text: profileBanner() },
          ...(result.content ?? []),
          ...(documentGuidance
            ? [{ type: "text" as const, text: documentGuidance }]
            : []),
        ],
      };
    } catch (err) {
      const error = err as Error;
      log("error", "Error in CallToolRequest handler:", error);
      return {
        content: [{
          type: "text",
          text: `${profileBanner()} Error: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // 도구 목록 요청 핸들러를 등록한다
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("info", "Handling ListToolsRequest");

    const toolsResponse = {
      tools: [
        {
          name: "mysql_query",
          description: mysqlQueryDescription(),
          inputSchema: mysqlQueryInputSchema,
          annotations: {
            readOnlyHint: isReadOnly,
            idempotentHint: isReadOnly,
            destructiveHint: !isReadOnly,
            openWorldHint: false,
            title: "MySQL Query",
          },
        },
        ...(catalog.isEnabled() ? [mysqlCatalogTool] : []),
      ],
    };

    log(
      "info",
      "ListToolsRequest response:",
      JSON.stringify(toolsResponse, null, 2),
    );
    return toolsResponse;
  });

  // mysql_query 설명에 붙는 자주 쓰는 테이블 목록은 시작 시점이 아니라, 테이블을 읽는
  // 첫 쿼리에서 채워진다. 카탈로그는 이 콜백을 한 번만 부르고, 그래서 알림도 세션당 한
  // 번으로 묶인다. 알림을 무시하는 클라이언트도 다음 tools/list에서 최신 설명을 받으므로,
  // 여기서 실패해도 재시도나 경고가 필요하지 않다.
  catalog.onToolDescriptionFilled(async () => {
    await server.sendToolListChanged().catch(() => undefined);
  });

  // 데이터베이스 연결을 초기화하고 종료 핸들러를 준비한다
  (async () => {
    try {
      if (SSH_ENABLED) {
        log("info", "Opening SSH tunnel before connecting to MySQL...");
        const endpoint = await ensureTunnel();
        log(
          "info",
          `SSH tunnel ready on ${endpoint?.host}:${endpoint?.port}` +
            (endpoint?.reused ? " (reused an existing forward)" : ""),
        );
      }
      log("info", "Attempting to test database connection...");
      // 서버를 완전히 띄우기 전에 연결을 확인한다
      const pool = await getPool();
      const connection = await pool.getConnection();
      log("info", "Database connection test successful");
      connection.release();
      // 인벤토리 수집은 일부러 떼어 놓는다. 이 메타데이터 쿼리 하나가 도는 동안에도
      // MCP 클라이언트는 쿼리 응답을 받을 수 있다.
      catalog.startInventory();
    } catch (error) {
      // 시작 실패는 ENABLE_LOGGING과 무관하게 운영자가 이유를 알아야 하는 유일한 지점이다.
      // 여기서 조용히 종료하면 MCP 클라이언트에는 설명 없는 핸드셰이크 실패로 보인다.
      // stderr로만 쓴다. stdout은 MCP 프로토콜 몫이다.
      console.error(
        `[startup] fatal error for profile ${PROFILE_LABEL}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      log("error", "Fatal error during server startup:", error);
      await stopTunnel();
      safeExit(1);
    }
  })();

  // 종료 핸들러를 설정한다
  const shutdown = async (signal: string): Promise<void> => {
    log("error", `Received ${signal}. Shutting down...`);
    try {
      await catalog.close();
      // 풀이 실제로 만들어졌을 때만 닫기를 시도한다
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.end();
      }
    } catch (err) {
      // 기록만 하고 계속 진행한다. 풀이 이미 망가졌더라도 터널은 반드시 닫아야 한다.
      // 그러지 않으면 SSH 세션과 loopback 리스너가 그대로 샌다.
      log("error", "Error closing pool:", err);
    } finally {
      await stopTunnel();
    }
  };

  // MCP 클라이언트는 시그널을 보내는 대신 우리 stdin을 닫아서 종료를 알린다. 이 처리가
  // 없으면 클라이언트가 사라진 뒤에도 프로세스가 터널을 연 채로 남는다.
  const shutdownAndExit = async (reason: string): Promise<void> => {
    try {
      await shutdown(reason);
    } catch (err) {
      log("error", `Error during ${reason} shutdown:`, err);
    }
    process.exit(0);
  };

  process.stdin.once("end", () => void shutdownAndExit("stdin end"));
  process.stdin.once("close", () => void shutdownAndExit("stdin close"));

  process.on("SIGINT", async () => {
    try {
      await shutdown("SIGINT");
      process.exit(0);
    } catch (err) {
      log("error", "Error during SIGINT shutdown:", err);
      safeExit(1);
    }
  });

  process.on("SIGTERM", async () => {
    try {
      await shutdown("SIGTERM");
      process.exit(0);
    } catch (err) {
      log("error", "Error during SIGTERM shutdown:", err);
      safeExit(1);
    }
  });

  // 처리되지 않은 오류를 받을 리스너를 등록한다
  process.on("uncaughtException", (error) => {
    log("error", "Uncaught exception:", error);
    safeExit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log("error", "Unhandled rejection at:", promise, "reason:", reason);
    safeExit(1);
  });

  return server;
}

/**
* 현재 모듈이 메인 모듈(애플리케이션의 진입점)인지 확인한다.
* ES Modules(ESM)와 CommonJS 양쪽에서 모두 동작한다.
* @returns {boolean} - 메인 모듈이면 true, 아니면 false.
*/
const isMainModule = () => {
  // 1. CommonJS의 표준 확인 방법
  // `require.main`은 애플리케이션의 진입점 모듈을 가리킨다.
  // 그것이 현재 `module`과 같으면 이 파일이 직접 실행된 것이다.
  if (typeof require !== 'undefined' && require.main === module) {
    return true;
  }
  // 2. ES Modules(ESM)의 확인 방법
  // `import.meta.url`은 현재 모듈의 파일 URL을 알려 준다.
  // `process.argv[1]`은 실행된 스크립트의 경로를 알려 준다.
  if (typeof import.meta !== 'undefined' && import.meta.url && process.argv[1]) {
    // `import.meta.url`(예: 'file:///path/to/file.js')을 시스템 표준 절대 경로로 바꾼다.
    const currentModulePath = fileURLToPath(import.meta.url);
    // 상대 경로일 수 있는 `process.argv[1]`을 표준 절대 경로로 정규화한다.
    const mainScriptPath = realpathSync(process.argv[1]);
    // 정규화한 두 절대 경로를 비교한다.
    return currentModulePath === mainScriptPath;
  }
  // 위 두 조건 어디에도 해당하지 않을 때의 기본값.
  return false;
}

// 이 파일을 직접 실행한 경우에만 서버를 띄운다
if (isMainModule()) {
  log("info", "Running in standalone mode");

  // 서버를 시작한다
  (async () => {
    try {
      const mcpServer = createMcpServer();
      const transport = new StdioServerTransport();
      await mcpServer.connect(transport);
      log("info", "Server started and listening on stdio");
    } catch (error) {
      // 서버를 만드는 과정에서 SSH 터널 대상과 카탈로그 식별자가 정해진다. 그래서 환경
      // 설정이 잘못되면 `createMcpServer` 안의 시작 블록이 아니라 여기서 실패한다. 그
      // 블록과 같은 이유로 ENABLE_LOGGING과 무관하게 이유를 출력한다. MCP 클라이언트에는
      // 조용한 종료가 설명 없는 핸드셰이크 실패로 보이기 때문이다.
      console.error(
        `[startup] fatal error for profile ${PROFILE_LABEL}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      log("error", "Server error:", error);
      safeExit(1);
    }
  })();
}
