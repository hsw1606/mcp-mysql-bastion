import * as dotenv from "dotenv";
import * as fs from "fs";
import { AppSchemaEntry, SchemaPermissions } from "../types/index.js";
import { parseSchemaPermissions, parseMySQLConnectionString } from "../utils/index.js";

/**
 * Read and validate an SSL file (certificate, key, or CA) for SSL connections.
 * @param filePath - Path to the SSL file (PEM format)
 * @param label - Human-readable label for error messages (e.g. "CA certificate", "client certificate")
 * @returns Buffer containing the file data
 * @throws Error if file doesn't exist, is empty, or cannot be read
 */
function readSSLFile(filePath: string, label: string): Buffer {
  try {
    // Check if file exists and is readable
    if (!fs.existsSync(filePath)) {
      throw new Error(`SSL ${label} file not found: ${filePath}`);
    }

    // Read the file
    const data = fs.readFileSync(filePath);

    // Basic validation - check it's not empty
    if (data.length === 0) {
      throw new Error(`SSL ${label} file is empty: ${filePath}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw our custom errors as-is
      if (error.message.startsWith('SSL ')) {
        throw error;
      }
      // Wrap other errors (like permission denied)
      throw new Error(`Failed to read SSL ${label}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Read and validate CA certificate file for SSL connections.
 * @param filePath - Path to the CA certificate file (PEM format)
 * @returns Buffer containing the certificate data
 * @throws Error if file doesn't exist, is empty, or cannot be read
 */
function readCACertificate(filePath: string): Buffer {
  return readSSLFile(filePath, 'CA certificate');
}

/**
 * Version reported to MCP clients. Tracked independently of the upstream
 * project this fork derives from.
 */
export const MCP_VERSION = "1.0.0";

/**
 * Load the profile's environment.
 *
 * Three shapes, in priority order:
 *   1. `MYSQL_ENV_FILE` — load exactly that file and nothing else.
 *   2. `MYSQL_PROFILE` set — load `.env.<profile>` if present, and deliberately
 *      do NOT fall back to `.env`. A profile run must not inherit stray keys
 *      (e.g. a leftover `ALLOW_DELETE_OPERATION=true`) from a generic `.env`
 *      that the profile file never mentions.
 *   3. Neither set — the upstream behaviour: plain `.env`.
 *
 * In every case `dotenv` leaves already-exported variables untouched, so the
 * wrapper scripts in `bin/` remain authoritative.
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
 * Which environment this server instance is pointed at. Surfaced in the tool
 * description and in every query response so an operator can never mistake a
 * production result for a staging one.
 */
export const MYSQL_PROFILE = (process.env.MYSQL_PROFILE ?? "").trim().toLowerCase();

/**
 * Profiles whose write flags are refused at the code level.
 *
 * This is not a default that an environment variable can flip — `ALLOW_*` and
 * `SCHEMA_*_PERMISSIONS` are forced off below when the profile matches. The
 * point is that no combination of env files, shell exports, or MCP client
 * configuration can turn this server into something that writes to production.
 */
const WRITE_FORBIDDEN_PROFILES = new Set(["prod", "production"]);

export const IS_WRITE_FORBIDDEN_PROFILE =
  WRITE_FORBIDDEN_PROFILES.has(MYSQL_PROFILE);

/** Label used in tool descriptions and query responses. */
export const PROFILE_LABEL = MYSQL_PROFILE
  ? MYSQL_PROFILE.toUpperCase()
  : "UNSPECIFIED";

/**
 * Git branch whose code matches the data in this environment.
 *
 * A model reasoning about a query almost always needs the code that wrote the
 * rows, and picking the wrong branch is a silent error — stage schema read
 * against `main` looks like a missing column rather than a wrong checkout. So
 * the branch is declared here and repeated in the tool description and in
 * every response banner.
 *
 * `MYSQL_CODE_BRANCH` overrides; otherwise the conventional mapping for the
 * profile is used, and an unknown profile simply says nothing.
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
 * Parse `MYSQL_APP_SCHEMAS` into the application-to-schema map.
 *
 * Entries are separated by `;` or newlines — not commas, so a description can
 * read like a sentence. Each entry is `app:schema` with an optional third
 * field: `app:schema:what lives in it`. Only the first two colons split, so a
 * description may contain colons of its own.
 *
 * An app may appear more than once: one service legitimately owns several
 * schemas (a per-tenant one alongside a shared one), and dropping all but the
 * last mapping would hide a schema the model needs. Only an exact repeat of the
 * same app-and-schema pair is treated as a mistake.
 *
 * A malformed entry is reported and skipped rather than thrown: a typo in one
 * line must not take the server down, and the remaining mappings are still
 * worth having.
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
 * Declared application-to-schema map. Empty is a valid configuration — the
 * server then behaves exactly as it did before this existed.
 */
export const APP_SCHEMAS: readonly AppSchemaEntry[] = parseAppSchemas(
  process.env.MYSQL_APP_SCHEMAS,
);

/** Local schema catalog. Only the catalog is disabled when its setup fails. */
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

/** Git access is added by the catalog's document phase; an empty path is valid. */
export const MYSQL_DOCS_REPO = process.env.MYSQL_DOCS_REPO?.trim() || undefined;

// @INFO: Parse connection string if provided
// Connection string takes precedence over individual environment variables
const connectionStringConfig = process.env.MYSQL_CONNECTION_STRING
  ? parseMySQLConnectionString(process.env.MYSQL_CONNECTION_STRING)
  : {};

// @INFO: Update the environment setup to ensure database is correctly set
if (process.env.NODE_ENV === "test" && !process.env.MYSQL_DB) {
  process.env.MYSQL_DB = "mcp_test_db"; // @INFO: Ensure we have a database name for tests
}

// Write operation flags (global defaults).
//
// `envFlag` is the upstream behaviour; `writeFlag` layers the profile veto on
// top. Every write path in the server reads these constants, so forcing them
// false here is sufficient to make a profile read-only — there is no second
// place where `process.env.ALLOW_*` is consulted.
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
    // Loud, but not fatal: the flags are already neutralised. Exiting would
    // turn a harmless misconfiguration into an unusable server.
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
 * Multi-DB write escape hatch, also vetoed for write-forbidden profiles. Read
 * by `src/db/index.ts`, which otherwise consults `process.env` directly.
 */
export const MULTI_DB_WRITE_MODE = writeFlag("MULTI_DB_WRITE_MODE");

// Transaction mode control
export const MYSQL_DISABLE_READ_ONLY_TRANSACTIONS =
  process.env.MYSQL_DISABLE_READ_ONLY_TRANSACTIONS === "true";

/**
 * Read a positive integer environment variable, falling back to `fallback`
 * when it is unset or not a usable number. Follows the same shape as
 * `parseCatalogTtl`: report and continue, never throw. A server that refuses
 * to start over a mistyped limit is worse than one that runs on the default.
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
 * Server-side execution limit for a read query, in seconds.
 *
 * Every read runs under `max_execution_time`, so a query that cannot use an
 * index is cancelled instead of holding the tool call open until the MCP
 * client gives up. The default is short on purpose: this is an interactive
 * tool and a person is waiting for the answer.
 *
 * `mysql_query` may raise the limit per call via `timeout_seconds`, but only up
 * to `MYSQL_MAX_TIMEOUT_SECONDS`. The ceiling sits below the default tool
 * timeout of every MCP client we target, so the server is always the one that
 * reports the failure — a client giving up first would leave the model with no
 * diagnosis at all.
 */
export const MYSQL_MAX_TIMEOUT_SECONDS = parsePositiveInt(
  "MYSQL_MAX_TIMEOUT_SECONDS",
  process.env.MYSQL_MAX_TIMEOUT_SECONDS,
  30,
);

/**
 * Default when the caller passes no `timeout_seconds`. Clamped to the ceiling
 * so lowering `MYSQL_MAX_TIMEOUT_SECONDS` below 10 lowers the default with it,
 * rather than leaving a default no call could ever request.
 */
export const MYSQL_DEFAULT_TIMEOUT_SECONDS = Math.min(
  10,
  MYSQL_MAX_TIMEOUT_SECONDS,
);

/**
 * Time limit for the catalog's own `information_schema` reads.
 *
 * Separate from the user-facing limit because the two have different shapes: a
 * user query is interactive and should fail fast, while an inventory scan runs
 * in the background, touches every declared schema at once, and is worth
 * waiting longer for. The row cap is *not* shared — see `MAX_RESULT_ROWS`.
 */
export const MYSQL_CATALOG_TIMEOUT_SECONDS = parsePositiveInt(
  "MYSQL_CATALOG_TIMEOUT_SECONDS",
  process.env.MYSQL_CATALOG_TIMEOUT_SECONDS,
  60,
);

/**
 * Largest result a read query may return to the model.
 *
 * Not configurable. The number exists to protect the model's context window,
 * which is a property of the client rather than of this database, so an
 * operator turning it up per environment would be tuning the wrong knob. The
 * session runs with `sql_select_limit = MAX_RESULT_ROWS + 1` so that one extra
 * row proves truncation happened; a query carrying its own larger LIMIT
 * overrides `sql_select_limit` entirely, and is cut to the same size on the
 * way out.
 */
export const MAX_RESULT_ROWS = 5000;

// PII redaction: when enabled, read-only query results are walked and
// sensitive values are partially masked before being returned to the client.
// See src/security/redact.ts for the detection and masking rules.
export const ENABLE_PII_REDACTION =
  process.env.ENABLE_PII_REDACTION === "true";

// Operator-defined additions to the column-name heuristic. Empty entries are
// filtered out — an empty substring would match every key and mask the entire
// response. Lowercased at parse time to match the key-lowercasing inside
// `isPIIColumn`.
export const PII_EXTRA_COLUMNS: readonly string[] = (
  process.env.PII_EXTRA_COLUMNS ?? ""
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

/**
 * Parse `PII_EXTRA_COLUMN_PATTERNS` into a list of compiled `RegExp` objects.
 * Entries are semicolon-separated (not comma) so commas inside character
 * classes like `[a-z,.]` stay unambiguous. Each entry is a regex *body* — no
 * slash delimiters, no explicit flags. We compile with `i` so operators do
 * not have to think about casing, and the runtime lowers the key before
 * testing anyway.
 *
 * Invalid patterns are logged and skipped; one bad entry must not crash the
 * server or poison the rest of the list.
 */
function parseColumnPatterns(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  const out: RegExp[] = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      out.push(new RegExp(trimmed, "i"));
    } catch (err) {
      console.error(
        `[config] ignoring invalid PII_EXTRA_COLUMN_PATTERNS entry "${trimmed}": ${
          (err as Error).message
        }`,
      );
    }
  }
  return out;
}

export const PII_EXTRA_COLUMN_PATTERNS: readonly RegExp[] = parseColumnPatterns(
  process.env.PII_EXTRA_COLUMN_PATTERNS,
);

// When PII redaction is enabled, string column values that contain a valid JSON
// object or array are parsed and their inner fields are redacted by the same
// column-name heuristics as top-level columns. This catches PII inside audit
// columns like `new_value` / `old_value` whose column name alone does not
// trigger a PII rule. Set to false only if JSON parsing overhead is a concern.
export const PII_REDACT_JSON_STRINGS =
  process.env.PII_REDACT_JSON_STRINGS !== "false";

// When PII redaction is enabled, queries with `SELECT *` (or `t.*`) are
// rejected by default to force the LLM to project explicit column lists.
// Combined with PII column filtering in the schema response, this prevents
// the LLM from accidentally pulling redacted columns it never saw.
// Set `PII_ALLOW_SELECT_STAR=true` to opt out (e.g. for tables with no PII).
export const PII_ALLOW_SELECT_STAR =
  process.env.PII_ALLOW_SELECT_STAR === "true";

// When PII redaction is enabled, any reference to a column whose name matches
// a PII rule (built-in list, `PII_EXTRA_COLUMNS`, or `PII_EXTRA_COLUMN_PATTERNS`)
// causes the query to be rejected — regardless of where in the query the
// reference appears (projection, WHERE, JOIN ON, ORDER BY, subquery, ...).
// This closes the alias-bypass where `CONCAT(first_name, ' ', last_name) AS NAME`
// would render a redacted-column-aware result-key check useless.
// Set `PII_ALLOW_REFERENCES=true` to opt out.
export const PII_ALLOW_REFERENCES =
  process.env.PII_ALLOW_REFERENCES === "true";

// When PII redaction is enabled, queries that introspect schema metadata get
// special handling so the LLM can discover non-PII columns without ever seeing
// the PII ones:
//   - `SHOW COLUMNS`, `SHOW FULL COLUMNS`, `DESCRIBE`, `DESC`, `EXPLAIN <table>`,
//     `SHOW INDEX(ES)`, `SHOW KEYS` execute, and rows whose column-name field
//     matches a PII rule are filtered out of the response.
//   - `SHOW CREATE TABLE`, `SHOW CREATE VIEW`, `SHOW TABLES`, `SHOW TABLE STATUS`,
//     and any SELECT against `information_schema` / `mysql` schema are rejected
//     because they cannot be filtered safely without a custom parser.
// Set `PII_ALLOW_INTROSPECTION=true` to bypass both behaviours and return raw
// results unchanged.
export const PII_ALLOW_INTROSPECTION =
  process.env.PII_ALLOW_INTROSPECTION === "true";

// Optional stricter mode: restores the original "hard block" behaviour for
// every introspection statement (filterable kinds included). Useful when the
// row-filter default is too permissive for an environment.
// Ignored when `PII_ALLOW_INTROSPECTION=true` (which always wins).
export const PII_BLOCK_INTROSPECTION =
  process.env.PII_BLOCK_INTROSPECTION === "true";

// Schema-specific permissions.
//
// These are per-schema *overrides* of the global flags, so a write-forbidden
// profile has to blank them too — otherwise `SCHEMA_UPDATE_PERMISSIONS=foo:true`
// would re-open the door that the global veto just closed.
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

// Check if we're in multi-DB mode (no specific DB set)
const dbFromEnvOrConnString = connectionStringConfig.database || process.env.MYSQL_DB;
export const isMultiDbMode =
  !dbFromEnvOrConnString || dbFromEnvOrConnString.trim() === "";

export const mcpConfig = {
  server: {
    name: "@benborla29/mcp-server-mysql",
    version: MCP_VERSION,
    connectionTypes: ["stdio", "streamableHttp"],
  },
  mysql: {
    // Use Unix socket if provided (connection string takes precedence), otherwise use host/port
    ...(connectionStringConfig.socketPath || process.env.MYSQL_SOCKET_PATH
      ? {
          socketPath: connectionStringConfig.socketPath || process.env.MYSQL_SOCKET_PATH,
        }
      : {
          host: connectionStringConfig.host || process.env.MYSQL_HOST || "127.0.0.1",
          port: connectionStringConfig.port || Number(process.env.MYSQL_PORT || "3306"),
        }),
    user: connectionStringConfig.user || process.env.MYSQL_USER || "root",
    password:
      connectionStringConfig.password !== undefined
        ? connectionStringConfig.password
        : process.env.MYSQL_PASS === undefined
          ? ""
          : process.env.MYSQL_PASS,
    database: connectionStringConfig.database || process.env.MYSQL_DB || undefined, // Allow undefined database for multi-DB mode
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: process.env.MYSQL_QUEUE_LIMIT ? parseInt(process.env.MYSQL_QUEUE_LIMIT, 10) : 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: process.env.MYSQL_CONNECT_TIMEOUT ? parseInt(process.env.MYSQL_CONNECT_TIMEOUT, 10) : 10000,
    authPlugins: {
      mysql_clear_password: () => () =>
        Buffer.from(
          connectionStringConfig.password !== undefined
            ? connectionStringConfig.password
            : process.env.MYSQL_PASS !== undefined
              ? process.env.MYSQL_PASS
              : ""
        ),
    },
    ...(process.env.MYSQL_SSL === "true"
      ? {
          ssl: {
            rejectUnauthorized:
              process.env.MYSQL_SSL_REJECT_UNAUTHORIZED === "true",
            // Add CA certificate if provided
            ...(process.env.MYSQL_SSL_CA
              ? { ca: readCACertificate(process.env.MYSQL_SSL_CA) }
              : {}),
            // Add client certificate for mTLS if provided
            ...(process.env.MYSQL_SSL_CERT
              ? { cert: readSSLFile(process.env.MYSQL_SSL_CERT, 'client certificate') }
              : {}),
            // Add client private key for mTLS if provided
            ...(process.env.MYSQL_SSL_KEY
              ? { key: readSSLFile(process.env.MYSQL_SSL_KEY, 'client private key') }
              : {}),
          },
        }
      : {}),
    // Timezone configuration for date/time handling
    ...(process.env.MYSQL_TIMEZONE
      ? {
          timezone: process.env.MYSQL_TIMEZONE,
        }
      : {}),
    // Return date values as strings instead of JavaScript Date objects
    ...(process.env.MYSQL_DATE_STRINGS === "true"
      ? {
          dateStrings: true,
        }
      : {}),
    // Return BIGINT/DECIMAL values as strings to prevent precision loss
    // This is essential for tables using snowflake IDs (19-digit IDs) which exceed Number.MAX_SAFE_INTEGER (2^53-1)
    ...(process.env.MYSQL_BIG_NUMBER_STRINGS === "true"
      ? {
          supportBigNumbers: true,
          bigNumberStrings: true,
        }
      : {}),
  },
  paths: {
    schema: "schema",
  },
};

export { readCACertificate, readSSLFile };
