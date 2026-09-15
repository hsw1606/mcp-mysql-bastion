import { isMultiDbMode } from "./../config/index.js";
import { log } from "./../utils/index.js";
import SqlParser, { AST } from "node-sql-parser";

const { Parser } = SqlParser;
const parser = new Parser();

// Extract schema from SQL query using the AST parser for accuracy.
// Previous regex-based extraction could be bypassed with SQL comments
// (e.g. USE/**/schema_name) which allowed schema permission checks to
// fall through to the global default.
function extractSchemaFromQuery(sql: string): string | null {
  // Default schema from environment
  const defaultSchema = process.env.MYSQL_DB || null;

  // If we have a default schema and not in multi-DB mode, return it
  if (defaultSchema && !isMultiDbMode) {
    return defaultSchema;
  }

  // Use the AST parser to reliably extract schema information
  try {
    const astOrArray: AST | AST[] = parser.astify(sql, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

    for (const stmt of statements) {
      // Case 1: USE database statement
      if (stmt.type === "use" && (stmt as any).db) {
        return (stmt as any).db;
      }

      // Case 2: database.table notation in FROM/INTO clauses
      const tables = (stmt as any).table || (stmt as any).from;
      if (Array.isArray(tables)) {
        for (const t of tables) {
          if (t.db) {
            return t.db;
          }
        }
      } else if (tables && typeof tables === "object" && tables.db) {
        return tables.db;
      }
    }
  } catch (err: any) {
    log("error", "Failed to parse SQL for schema extraction:", err.message);
  }

  // Return default if we couldn't find a schema in the query
  return defaultSchema;
}

/**
 * MySQL EXPLAIN accepts optional modifiers between EXPLAIN and the statement:
 *   ANALYZE, EXTENDED, PARTITIONS, FORMAT=<word>
 *
 * node-sql-parser only understands bare `EXPLAIN <statement>` — any modifier
 * after EXPLAIN causes a parse error. Strip them before handing to the parser
 * so that e.g. `EXPLAIN ANALYZE SELECT …` is treated the same as
 * `EXPLAIN SELECT …` (operation type `"explain"`, routed as read-only).
 *
 * Multiple modifiers may appear together, e.g. `EXPLAIN ANALYZE FORMAT=JSON`.
 */
const EXPLAIN_MODIFIER_RE =
  /^(\s*EXPLAIN\s+)((?:ANALYZE\s+|EXTENDED\s+|PARTITIONS\s+|FORMAT\s*=\s*\w+\s+)+)/i;

function stripExplainModifiers(sql: string): string {
  return sql.replace(EXPLAIN_MODIFIER_RE, "$1");
}

async function getQueryTypes(query: string): Promise<string[]> {
  try {
    log("info", "Parsing SQL query: ", query);
    // Strip unsupported EXPLAIN modifiers (ANALYZE, FORMAT=…, EXTENDED, PARTITIONS)
    // before parsing so node-sql-parser can handle them.
    const normalised = stripExplainModifiers(query);
    // Parse into AST or array of ASTs - only specify the database type
    const astOrArray: AST | AST[] = parser.astify(normalised, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

    // Map each statement to its lowercased type (e.g., 'select', 'update', 'insert', 'delete', etc.)
    return statements.map((stmt) => stmt.type?.toLowerCase() ?? "unknown");
  } catch (err: any) {
    log("error", "sqlParser error, query: ", query);
    log("error", "Error parsing SQL query:", err);
    throw new Error(`Parsing failed: ${err.message}`);
  }
}

/**
 * Categorisation of a schema-introspection statement. `null` means the query is
 * not one. Used to route statements the SQL parser cannot model past the block
 * that would otherwise reject them on a parse error.
 */
export type IntrospectionKind =
  | "show_columns"
  | "show_create"
  | "show_index"
  // Table-/database-level metadata listings that expose only schema topology
  // (table names, database names, charset/collation lists). They have no
  // column-level information, so the executor lets them run unchanged.
  | "show_passthrough"
  | "show_other"
  | "describe"
  | "information_schema"
  | "mysql_schema";

export interface IntrospectionResult {
  kind: IntrospectionKind | null;
}

// Statements that node-sql-parser can't parse but still leak schema (e.g.
// `SHOW FULL COLUMNS FROM users`, `SHOW FIELDS FROM users`). We pre-screen
// for these via a textual check before falling through to the AST walk.
const SHOW_INTROSPECTION_RE =
  /^\s*SHOW\s+(?:FULL\s+)?(COLUMNS|FIELDS|CREATE\s+TABLE|CREATE\s+VIEW|INDEX(?:ES)?|KEYS|TABLE\s+STATUS|TABLES|DATABASES|SCHEMAS|CHARACTER\s+SET|CHARSET|COLLATION)\b/i;
const DESCRIBE_RE = /^\s*(?:DESCRIBE|DESC)\s+/i;
// `EXPLAIN <table>` is a synonym for `DESCRIBE <table>`, which the parser does
// not model, so it is classified here and routed past the parse. We must NOT
// match `EXPLAIN <select-stmt>` etc.: those are query-plan inspections that the
// parser handles, and routing them past it would skip write routing too. The
// negative look-ahead lists the query-statement keywords MySQL accepts after
// EXPLAIN.
const EXPLAIN_TABLE_RE =
  /^\s*EXPLAIN\s+(?!SELECT\b|INSERT\b|UPDATE\b|DELETE\b|REPLACE\b|ANALYZE\b|FORMAT\b|FOR\s|EXTENDED\b|PARTITIONS\b|\()[A-Za-z_`]/i;

/**
 * Identify queries that expose schema/column metadata. Combines a textual
 * pre-screen (catches statements the parser doesn't understand, like
 * `SHOW FULL COLUMNS FROM users`) with an AST walk (catches `db.table`
 * references to `information_schema` or `mysql` anywhere in the query,
 * including inside subqueries and joins).
 *
 * On parse failure with no textual match, returns `{ kind: null }` — the
 * downstream executor will reject or surface the parse error normally.
 */
function isIntrospectionQuery(sql: string): IntrospectionResult {
  const showMatch = sql.match(SHOW_INTROSPECTION_RE);
  if (showMatch) {
    const keyword = showMatch[1].toUpperCase().replace(/\s+/g, " ");
    if (keyword.startsWith("COLUMNS") || keyword.startsWith("FIELDS")) {
      return { kind: "show_columns" };
    }
    if (keyword.startsWith("CREATE")) {
      return { kind: "show_create" };
    }
    if (
      keyword.startsWith("INDEX") ||
      keyword.startsWith("KEYS")
    ) {
      return { kind: "show_index" };
    }
    // Table-/database-level listings: schema topology only, no column data.
    if (
      keyword === "TABLES" ||
      keyword.startsWith("TABLE STATUS") ||
      keyword === "DATABASES" ||
      keyword === "SCHEMAS" ||
      keyword.startsWith("CHARACTER") ||
      keyword === "CHARSET" ||
      keyword === "COLLATION"
    ) {
      return { kind: "show_passthrough" };
    }
    return { kind: "show_other" };
  }
  if (DESCRIBE_RE.test(sql) || EXPLAIN_TABLE_RE.test(sql)) {
    return { kind: "describe" };
  }

  let astOrArray: AST | AST[];
  try {
    astOrArray = parser.astify(sql, { database: "mysql" });
  } catch {
    return { kind: null };
  }
  const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];
  for (const stmt of statements) {
    const kind = findIntrospectionKind(stmt);
    if (kind) return { kind };
  }
  return { kind: null };
}

function findIntrospectionKind(node: unknown): IntrospectionKind | null {
  if (node == null || typeof node !== "object") return null;
  if (node instanceof Date) return null;

  const obj = node as Record<string, unknown>;

  if (obj.type === "show") {
    const keyword =
      typeof obj.keyword === "string" ? obj.keyword.toLowerCase() : "";
    if (keyword === "columns" || keyword === "fields") return "show_columns";
    if (keyword === "create") return "show_create";
    if (keyword === "index" || keyword === "keys") return "show_index";
    // Table-/database-level listings: schema topology only, no column data.
    // Empirically the parser produces `keyword: "tables" / "databases" /
    // "character" / "collation"` for the parse-able cases. SHOW TABLE STATUS,
    // SHOW SCHEMAS, and SHOW CHARSET fail to parse entirely — those are
    // covered by the textual pre-screen at the top of `isIntrospectionQuery`.
    if (
      keyword === "tables" ||
      keyword === "databases" ||
      keyword === "character" ||
      keyword === "collation"
    ) {
      return "show_passthrough";
    }
    return "show_other";
  }
  if (obj.type === "desc" || obj.type === "describe") {
    return "describe";
  }

  // Reference to a metadata schema anywhere in the AST (`from`, JOIN target,
  // subquery, etc.). The AST stores the schema name in lowercase already, but
  // we lower again defensively for portability across parser versions.
  if (typeof obj.db === "string") {
    const db = obj.db.toLowerCase();
    if (db === "information_schema") return "information_schema";
    if (db === "mysql") return "mysql_schema";
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const kind = findIntrospectionKind(item);
        if (kind) return kind;
      }
    } else if (value && typeof value === "object") {
      const kind = findIntrospectionKind(value);
      if (kind) return kind;
    }
  }
  return null;
}

/** Table qualifier -> the table it names, for aliases and bare table names. */
export type QualifierMap = Map<string, { schema: string | null; table: string }>;

function isRecord(node: unknown): node is Record<string, unknown> {
  return node != null && typeof node === "object" && !(node instanceof Date);
}

/**
 * Map every table qualifier a query can use — alias first, table name as a
 * fallback — to the table it stands for. Built from the same `from` entries
 * node-sql-parser produces for `extractQueryConditions`, so the two agree on
 * what `s.status` refers to.
 */
function extractQualifiers(sql: string): QualifierMap {
  const map: QualifierMap = new Map();
  let astOrArray: AST | AST[];
  try {
    astOrArray = parser.astify(stripExplainModifiers(sql), { database: "mysql" });
  } catch {
    return map;
  }
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (
      node.type !== "column_ref" &&
      typeof node.table === "string" &&
      (typeof node.db === "string" || node.db === null)
    ) {
      const reference = {
        schema: typeof node.db === "string" && node.db ? node.db : null,
        table: node.table,
      };
      map.set(node.table.toLowerCase(), reference);
      if (typeof node.as === "string" && node.as) {
        map.set(node.as.toLowerCase(), reference);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else visit(value);
    }
  };
  visit(astOrArray);
  return map;
}

export {
  extractSchemaFromQuery,
  getQueryTypes,
  isIntrospectionQuery,
  extractQualifiers,
  stripExplainModifiers,
};
