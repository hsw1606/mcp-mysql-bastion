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
  containsSelectStar,
  findPIIColumnReferences,
  isIntrospectionQuery,
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
  ENABLE_PII_REDACTION,
  PII_EXTRA_COLUMNS,
  PII_EXTRA_COLUMN_PATTERNS,
  PII_REDACT_JSON_STRINGS,
  PII_ALLOW_SELECT_STAR,
  PII_ALLOW_REFERENCES,
  PII_ALLOW_INTROSPECTION,
  PII_BLOCK_INTROSPECTION,
  MYSQL_DEFAULT_TIMEOUT_SECONDS,
  MYSQL_MAX_TIMEOUT_SECONDS,
  MYSQL_CATALOG_TIMEOUT_SECONDS,
  MAX_RESPONSE_ROWS,
} from "./../config/index.js";
import {
  redactPII,
  isPIIColumn,
  DEFAULT_PII_COLUMNS,
  filterIntrospectionRows,
  type FilterableIntrospectionKind,
} from "./../security/redact.js";

// Force read-only mode in multi-DB mode unless explicitly configured otherwise
if (isMultiDbMode && !MULTI_DB_WRITE_MODE) {
  log("error", "Multi-DB mode detected - enabling read-only mode for safety");
}

// @INFO: Check if running in test mode
const isTestEnvironment = process.env.NODE_ENV === "test" || process.env.VITEST;

// @INFO: Safe way to exit process (not during tests)
function safeExit(code: number): void {
  if (!isTestEnvironment) {
    process.exit(code);
  } else {
    log("error", `[Test mode] Would have called process.exit(${code})`);
  }
}

// @INFO: Lazy load MySQL pool
let poolPromise: Promise<mysql2.Pool> | undefined;

/**
 * Session limits a connection is currently running under.
 *
 * `selectLimit: null` means `sql_select_limit = DEFAULT`, i.e. no row cap.
 */
interface SessionLimits {
  maxExecutionTimeMs: number;
  selectLimit: number | null;
}

/** What a user-facing read runs under unless the call asked for more time. */
const READ_LIMITS: SessionLimits = {
  maxExecutionTimeMs: MYSQL_DEFAULT_TIMEOUT_SECONDS * 1_000,
  selectLimit: MAX_RESPONSE_ROWS + 1,
};

/**
 * What the catalog's own reads run under.
 *
 * The row cap is deliberately absent. `sql_select_limit` is a session variable
 * on a pool shared with the user path, so a cap left behind by a user query
 * would silently truncate the inventory scan — a schema with more than
 * MAX_RESPONSE_ROWS tables would be cached as a partial list, with nothing
 * anywhere saying so. The time limit is kept, and set higher, because an
 * inventory scan legitimately runs longer than an interactive query.
 */
const CATALOG_LIMITS: SessionLimits = {
  maxExecutionTimeMs: MYSQL_CATALOG_TIMEOUT_SECONDS * 1_000,
  selectLimit: null,
};

// Recorded on the physical connection, which outlives the per-acquisition
// wrapper `pool.getConnection()` hands back. Keyed by a symbol so it cannot
// collide with anything mysql2 stores there.
const SESSION_LIMITS = Symbol.for("mcp-mysql-bastion.sessionLimits");

type LimitCarrier = { [SESSION_LIMITS]?: SessionLimits };

/** The physical connection behind a promise-API wrapper. */
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
 * Bring a connection to `desired`, and report whether that cost a round trip.
 *
 * Nothing happens when the connection already carries those limits, which is
 * the common case: `getPool` primes every new physical connection with
 * `READ_LIMITS`, so an ordinary read spends no round trip here at all.
 *
 * A failure is logged and swallowed. Both variables have existed since MySQL
 * 5.7, so this is a branch for a server we do not target, and there refusing
 * every query would be a far worse outcome than running one unlimited.
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
 * Create the connection pool, opening an SSH tunnel first when one is
 * configured.
 *
 * The tunnel is awaited before `createPool` is called, and `ensureTunnel()`
 * only resolves once the local port is actually listening — so the pool is
 * never handed an address that nothing is bound to yet. When no tunnel is
 * configured this behaves exactly as upstream did.
 *
 * A failure here is not cached: `poolPromise` is cleared so the next query can
 * retry once the bastion or database is reachable again.
 */
const getPool = (): Promise<mysql2.Pool> => {
  if (!poolPromise) {
    poolPromise = (async (): Promise<mysql2.Pool> => {
      const endpoint = await ensureTunnel();

      // Point the pool at the tunnel's loopback address. `socketPath` is
      // dropped because mysql2 prefers it over host/port, which would silently
      // bypass the tunnel we just opened.
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

      // Prime every new physical connection with the read limits.
      //
      // mysql2 emits `connection` before it hands the connection to whoever
      // asked for it, and commands run in the order they were queued, so this
      // SET is already done by the time the first query on that connection
      // runs. Paying for it here rather than per query is what keeps an
      // ordinary read at three round trips: start the transaction, run the
      // query, roll back. The cost lands inside connection setup, which is
      // several round trips of TCP, SSH, and MySQL handshake already.
      //
      // The event carries the callback-style connection, not the promise
      // wrapper the rest of this file uses, so the query is issued in that
      // style.
      pool.on("connection", (connection) => {
        const carrier = limitCarrier(connection);
        const raw = connection as unknown as {
          query(sql: string, callback: (error: unknown) => void): void;
        };
        // Marked before the response arrives, not in the callback. The pool
        // hands the connection to its first caller immediately, so a marker
        // written on completion would still be unset when that caller checks
        // it — and the caller would queue a second, identical SET. Queued is
        // the state that matters here: commands run in order, so anything sent
        // afterwards already sees these limits.
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
 * Reject early with a clear message when the tunnel has permanently dropped.
 * Without this the caller would instead see an opaque ECONNRESET from mysql2
 * against a loopback port whose listener no longer forwards anywhere.
 */
function assertTunnelHealthy(): void {
  const fatal = getTunnelFatalError();
  if (fatal) throw fatal;
}

/**
 * One-line banner prepended to every tool response so the environment behind a
 * result is never ambiguous.
 */
function profileBanner(): string {
  const parts = [`profile: ${PROFILE_LABEL}`];
  parts.push(IS_WRITE_FORBIDDEN_PROFILE ? "READ-ONLY (enforced)" : "read-only");
  const db = config.mysql.database || "multi-db";
  parts.push(`database: ${db}`);
  // Repeated on every result, not just at tool-selection time: a long session
  // reading both environments should never have to scroll back to remember
  // which branch the rows in front of it belong to.
  if (CODE_BRANCH) parts.push(`code: ${CODE_BRANCH} branch`);
  const tunnel = describeTunnel();
  if (tunnel) parts.push(tunnel);
  return `[${parts.join(" | ")}]`;
}

/**
 * The catalog's path to the database. Shares the pool with the read path, and
 * therefore has to correct the session limits at both ends.
 *
 * Lifting the row cap before the query is the part that matters: a truncated
 * `information_schema` scan produces a catalog that is quietly wrong rather
 * than obviously broken, and nothing downstream can tell the difference.
 * Restoring the read limits afterwards is what keeps that correction from
 * costing the *next* user query a round trip. Both calls run off the response
 * path — the inventory scan is a startup task and detail collection is
 * scheduled in the background — so the two extra round trips are free where it
 * counts.
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
        // `applySessionLimits` already swallows query failures; this only
        // catches something unexpected. The connection is released either way,
        // and the marker it clears makes the next caller reconcile.
        log("error", "Error restoring session limits:", restoreError);
      }
      connection.release();
      log("error", "Connection released");
    }
  }
}

// @INFO: New function to handle write operations
async function executeWriteQuery<T>(sql: string): Promise<T> {
  let connection;

  // Defence in depth. `src/config/index.ts` already forces every ALLOW_* flag
  // and schema override to false for a write-forbidden profile, so this branch
  // should be unreachable. It exists so that a future refactor of the routing
  // logic in `executeReadOnlyQuery` cannot reintroduce a write path to prod.
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

    // Extract schema for permissions (if needed)
    const schema = extractSchemaFromQuery(sql);

    // @INFO: Begin transaction for write operation
    await connection.beginTransaction();

    try {
      // @INFO: Execute the write query
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const response = Array.isArray(result) ? result[0] : result;

      // @INFO: Commit the transaction
      await connection.commit();

      // @INFO: Format the response based on operation type
      let responseText;

      // Check the type of query
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

      // @INFO: Type assertion for ResultSetHeader which has affectedRows, insertId, etc.
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
      // @INFO: Rollback on error
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
 * Where the timeout diagnosis gets its index knowledge.
 *
 * Injected rather than imported: `src/catalog/collect.ts` already imports
 * `executeQuery` from this module, and importing the catalog back would close
 * the cycle. The diagnosis is also optional — with the catalog disabled the
 * source stays null and every verdict falls through to "undetermined", which is
 * the honest answer when nothing knows what is indexed.
 */
export interface QueryDiagnosticsSource {
  indexFacts(reference: {
    schema: string | null;
    table: string;
  }): CatalogIndexFacts | null;
  redactsColumns(): boolean;
}

let diagnosticsSource: QueryDiagnosticsSource | null = null;

function setQueryDiagnosticsSource(source: QueryDiagnosticsSource | null): void {
  diagnosticsSource = source;
}

export interface ReadQueryOptions {
  /** Server-side execution limit. Clamped to the configured range. */
  timeoutSeconds?: number;
}

/**
 * Bring a requested timeout into the allowed range.
 *
 * Clamped rather than rejected. The bound exists to stop a query from running
 * away, and a caller who asks for 100 seconds wants the longest run available,
 * not an argument about it.
 */
function clampTimeoutSeconds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return MYSQL_DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.max(Math.floor(requested), 1), MYSQL_MAX_TIMEOUT_SECONDS);
}

/**
 * Build the text that replaces a cancelled query's rows.
 *
 * The one EXPLAIN this server ever runs happens here, on the connection that
 * just failed, and only after it failed. A plan fetched before every query
 * would put a round trip on the healthy ones to spare the broken ones a
 * timeout, which is the wrong way round: the cost belongs to the query that
 * earned it.
 *
 * EXPLAIN does not execute the statement, so it cannot repeat the timeout. It
 * does bypass the introspection guard, though — it is issued from inside this
 * executor rather than sent by a caller — and plans carry the literals a query
 * filtered on. Masking those is `renderTimeoutDiagnostic`'s job, and no plan
 * reaches the response by any other route.
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
    // EXPLAIN names the alias where the query used one, so a plan table is
    // resolved through the same qualifier map the conditions were read with.
    lookupIndexes: (name) => {
      if (!source) return null;
      const resolved = qualifiers.get(name.toLowerCase());
      return source.indexFacts(resolved ?? { schema: null, table: name });
    },
    indexListMayOmitColumns: source?.redactsColumns() ?? false,
  });
}

async function executeReadOnlyQuery<T>(
  sql: string,
  options: ReadQueryOptions = {},
): Promise<T> {
  let connection;
  try {
    assertTunnelHealthy();
    // PII redaction works hand-in-hand with explicit column projection: the
    // schema endpoint hides redacted columns, so the LLM should never need
    // SELECT *. Refusing wildcard projections here prevents the LLM from
    // accidentally pulling redacted columns it never saw in the schema.
    if (
      ENABLE_PII_REDACTION &&
      !PII_ALLOW_SELECT_STAR &&
      containsSelectStar(sql)
    ) {
      log(
        "error",
        "Refusing query with SELECT * while PII redaction is enabled; project explicit columns instead.",
      );
      return {
        content: [
          {
            type: "text",
            text:
              "Error: SELECT * (and `table.*`) is not permitted while PII redaction is enabled. " +
              "Project an explicit column list (e.g. SELECT col1, col2 FROM ...) so redacted columns are not accidentally returned. " +
              "Set PII_ALLOW_SELECT_STAR=true to override this policy.",
          },
        ],
        isError: true,
      } as T;
    }

    // Introspection guard. Three sub-policies under ENABLE_PII_REDACTION:
    //   - filterable (SHOW COLUMNS / DESCRIBE / SHOW INDEX): execute, then
    //     drop PII rows from the result.
    //   - passthrough (SHOW TABLES / SHOW DATABASES / charset / collation /
    //     etc.): execute unchanged. These expose only schema topology (table
    //     and database names), no column-level PII.
    //   - rejected (SHOW CREATE TABLE, information_schema.*, mysql.*, plus
    //     any unrecognised SHOW): blocked, because we can't safely filter
    //     them and they can leak column names verbatim.
    // PII_ALLOW_INTROSPECTION=true bypasses the guard entirely.
    // PII_BLOCK_INTROSPECTION=true restores the old hard-block behaviour for
    // every introspection kind, including filterable and passthrough.
    let introspectionFilterKind: FilterableIntrospectionKind | null = null;
    let isIntrospectionPassThrough = false;
    if (ENABLE_PII_REDACTION && !PII_ALLOW_INTROSPECTION) {
      const intro = isIntrospectionQuery(sql);
      if (intro.kind) {
        const filterable: FilterableIntrospectionKind | null =
          intro.kind === "show_columns" ||
          intro.kind === "describe" ||
          intro.kind === "show_index"
            ? intro.kind
            : null;
        const passthrough = intro.kind === "show_passthrough";

        if (PII_BLOCK_INTROSPECTION || (!filterable && !passthrough)) {
          log(
            "error",
            `Refusing introspection query (${intro.kind}) while PII redaction is enabled.`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: SQL introspection (${intro.kind}) is not permitted while PII redaction is enabled. ` +
                  `Use the mysql://tables and mysql://tables/{name} MCP resources to inspect schemas (PII columns are filtered there), ` +
                  `or use SHOW COLUMNS / DESCRIBE / SHOW INDEX (PII columns will be filtered from the result). ` +
                  `Set PII_ALLOW_INTROSPECTION=true to bypass this policy entirely.`,
              },
            ],
            isError: true,
          } as T;
        }
        if (filterable) {
          // Filterable kind: allow through; we'll drop PII rows from the
          // result before returning it.
          introspectionFilterKind = filterable;
        } else if (passthrough) {
          // Passthrough kind: nothing to set up — just skip the queryTypes /
          // permissions block below (the parser doesn't model these
          // statements) and let the executor run the SQL as-is.
          isIntrospectionPassThrough = true;
        }
      }
    }

    // PII column-reference guard: refuse queries that mention any redacted
    // column anywhere in the AST (projection, WHERE, JOIN ON, ORDER BY,
    // subqueries, ...). This closes alias-bypasses such as
    // `CONCAT(first_name, ' ', last_name) AS NAME` where the result-key
    // redactor never gets a chance because the output column is renamed.
    if (ENABLE_PII_REDACTION && !PII_ALLOW_REFERENCES) {
      const piiList = [...DEFAULT_PII_COLUMNS, ...PII_EXTRA_COLUMNS];
      const hits = findPIIColumnReferences(sql, (col) =>
        isPIIColumn(col, piiList, PII_EXTRA_COLUMN_PATTERNS),
      );
      if (hits.length > 0) {
        const names = hits
          .map((h) => (h.table ? `${h.table}.${h.column}` : h.column))
          .join(", ");
        log(
          "error",
          `Refusing query referencing redacted column(s): ${names}.`,
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Error: query references redacted column(s): ${names}. ` +
                `These columns are protected by PII redaction policy and cannot be projected, ` +
                `filtered, joined, or ordered on. Choose a different projection, ` +
                `or set PII_ALLOW_REFERENCES=true to override this policy.`,
            },
          ],
          isError: true,
        } as T;
      }
    }

    // Introspection statements (filterable + passthrough) are inherently
    // read-only and `node-sql-parser` doesn't model most of them (SHOW TABLE
    // STATUS, SHOW SCHEMAS, SHOW CHARSET fail to parse outright). Skip the
    // queryType + permission + write-routing block entirely for these and
    // execute them directly below.
    let queryTypes: string[] = [];
    let schema: string | null = null;
    let isUpdateOperation = false;
    let isInsertOperation = false;
    let isDeleteOperation = false;
    let isDDLOperation = false;

    if (!introspectionFilterKind && !isIntrospectionPassThrough) {
      queryTypes = await getQueryTypes(sql);
      schema = extractSchemaFromQuery(sql);
      isUpdateOperation = queryTypes.some((type) => ["update"].includes(type));
      isInsertOperation = queryTypes.some((type) => ["insert"].includes(type));
      isDeleteOperation = queryTypes.some((type) => ["delete"].includes(type));
      isDDLOperation = queryTypes.some((type) =>
        ["create", "alter", "drop", "truncate"].includes(type),
      );
    }

    // Check schema-specific permissions
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

    // For write operations that are allowed, use executeWriteQuery
    if (
      (isInsertOperation && isInsertAllowedForSchema(schema)) ||
      (isUpdateOperation && isUpdateAllowedForSchema(schema)) ||
      (isDeleteOperation && isDeleteAllowedForSchema(schema)) ||
      (isDDLOperation && isDDLAllowedForSchema(schema))
    ) {
      return executeWriteQuery(sql);
    }

    // For read-only operations, continue with the original logic
    const pool = await getPool();
    connection = await pool.getConnection();
    log("error", "Read-only connection acquired");

    // Round trips are counted, not estimated, because the budget is the whole
    // reason this path looks the way it does. Every hop crosses the SSH tunnel
    // at roughly 160 ms, so the three below are most of what a fast query costs.
    const timeoutSeconds = clampTimeoutSeconds(options.timeoutSeconds);
    let roundTrips = await applySessionLimits(connection, {
      maxExecutionTimeMs: timeoutSeconds * 1_000,
      selectLimit: MAX_RESPONSE_ROWS + 1,
    });

    // One statement both opens the transaction and declares its access mode,
    // where setting the session default and then beginning a transaction would
    // take two. Scoping the mode to the transaction also means there is nothing
    // to put back afterwards: the mode ends when the rollback does.
    if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
      await connection.query("START TRANSACTION READ ONLY");
    } else {
      log("info", "Read-only transactions disabled via MYSQL_DISABLE_READ_ONLY_TRANSACTIONS=true");
      await connection.beginTransaction();
    }
    roundTrips += 1;

    try {
      // Execute query - in multi-DB mode, we may need to handle USE statements specially
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      roundTrips += 1;
      let rows: unknown = Array.isArray(result) ? result[0] : result;

      // Rollback transaction (since it's read-only)
      await connection.rollback();
      roundTrips += 1;
      log("info", `Read query completed in ${roundTrips} DB round trips`);

      // Truncation is judged on the rows the server sent, before any filtering
      // or redaction shortens the list. Counting a redacted result would make
      // the warning depend on what was masked out of it.
      //
      // `sql_select_limit` bounds the transfer for a query that carries no
      // LIMIT of its own; one carrying a larger LIMIT overrides the session
      // variable entirely, so the same cut is applied here either way.
      let truncated = false;
      if (Array.isArray(rows) && rows.length > MAX_RESPONSE_ROWS) {
        truncated = true;
        rows = rows.slice(0, MAX_RESPONSE_ROWS);
      }

      // For introspection results we drop PII rows BEFORE the value-level
      // redactor runs. The order matters because once a row is dropped, its
      // metadata (e.g. column type, comment) can't leak via the redactor
      // either. Fail closed on unrecognised row shape — the classifier
      // believed this was a filterable introspection statement, but the
      // result rows don't have the expected `Field`/`Column_name` key. That
      // mismatch usually means an EXPLAIN of a non-table slipped through;
      // we'd rather refuse than return raw metadata.
      let intermediate: unknown = rows;
      if (introspectionFilterKind) {
        const piiList = [...DEFAULT_PII_COLUMNS, ...PII_EXTRA_COLUMNS];
        const filtered = filterIntrospectionRows(
          rows,
          introspectionFilterKind,
          (col) => isPIIColumn(col, piiList, PII_EXTRA_COLUMN_PATTERNS),
        );
        if (filtered === null) {
          log(
            "error",
            `Refusing introspection result (${introspectionFilterKind}): unrecognised row shape, cannot filter PII safely.`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: could not safely filter introspection result for kind '${introspectionFilterKind}'. ` +
                  `Use SHOW COLUMNS / DESCRIBE / SHOW INDEX against a real table, ` +
                  `or set PII_ALLOW_INTROSPECTION=true to bypass filtering.`,
              },
            ],
            isError: true,
          } as T;
        }
        intermediate = filtered;
      }

      const payload = ENABLE_PII_REDACTION
        ? redactPII(intermediate, {
            extraColumns: PII_EXTRA_COLUMNS,
            columnPatterns: PII_EXTRA_COLUMN_PATTERNS,
            parseJsonStrings: PII_REDACT_JSON_STRINGS,
          })
        : intermediate;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
          // The warning goes in its own block, ahead of the timing line, so a
          // partial result is never read as a whole one. Cutting quietly would
          // let the model answer "there are 5000" about a table with more.
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
      // Rollback transaction on query error
      log("error", "Error executing read-only query:", error);
      await connection.rollback();

      // A statement MySQL cancelled for exceeding its limit is the one error
      // this path answers instead of raising. The model is about to decide
      // whether to retry, rewrite, or ask the user, and it can only do that
      // from a plan — which it would otherwise fetch itself, at the cost of
      // another round trip and, at worst, another run of the same query.
      // Rollback above happens first, exactly as it does for any other failure.
      if (isQueryTimeoutError(error)) {
        const diagnostic = await diagnoseTimeout(connection, sql, timeoutSeconds);
        log(
          "info",
          // The counter stopped before the statement that threw: add the
          // cancelled query, the rollback, and the single diagnostic EXPLAIN.
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
    // Ensure we roll back on any error. There is no transaction mode to
    // restore: `START TRANSACTION READ ONLY` scopes the access mode to the
    // transaction the rollback just ended.
    log("error", "Error in read-only query transaction:", error);
    try {
      if (connection) {
        await connection.rollback();
      }
    } catch (cleanupError) {
      // Ignore errors during cleanup
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
