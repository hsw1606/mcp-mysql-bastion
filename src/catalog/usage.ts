import SqlParser, { type AST } from "node-sql-parser";
import type {
  PreparedCatalogQuery,
  QueryJoin,
  TableReference,
} from "./types.js";

const { Parser } = SqlParser;
const parser = new Parser();
const LITERAL_TYPES = new Set([
  "single_quote_string",
  "double_quote_string",
  "number",
  "hex",
  "bool",
  "date",
  "time",
  "timestamp",
]);

function referencesFromTableList(sql: string): TableReference[] {
  const seen = new Set<string>();
  const references: TableReference[] = [];
  for (const encoded of parser.tableList(sql, { database: "mysql" })) {
    const parts = encoded.split("::");
    const schema = parts[1] && parts[1] !== "null" ? parts[1] : null;
    const table = parts.slice(2).join("::");
    if (!table) continue;
    const key = `${schema ?? ""}.${table}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ schema, table });
  }
  return references;
}

function replaceLiterals(node: unknown): void {
  if (node == null || typeof node !== "object" || node instanceof Date) return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === "string" && LITERAL_TYPES.has(obj.type)) {
    for (const key of Object.keys(obj)) delete obj[key];
    obj.type = "origin";
    obj.value = "?";
    return;
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) replaceLiterals(item);
    } else {
      replaceLiterals(value);
    }
  }
}

function normalizeSql(ast: AST | AST[]): string | null {
  try {
    const clone = structuredClone(ast);
    replaceLiterals(clone);
    return parser.sqlify(clone, { database: "mysql" });
  } catch {
    return null;
  }
}

function collectAliases(
  node: unknown,
  aliases: Map<string, TableReference>,
): void {
  if (node == null || typeof node !== "object" || node instanceof Date) return;
  const obj = node as Record<string, unknown>;
  if (
    obj.type !== "column_ref" &&
    typeof obj.table === "string" &&
    (typeof obj.db === "string" || obj.db === null)
  ) {
    const reference = {
      schema: typeof obj.db === "string" ? obj.db : null,
      table: obj.table,
    };
    aliases.set(obj.table.toLowerCase(), reference);
    if (typeof obj.as === "string") aliases.set(obj.as.toLowerCase(), reference);
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectAliases(item, aliases);
    } else {
      collectAliases(value, aliases);
    }
  }
}

function columnEndpoint(
  node: unknown,
  aliases: Map<string, TableReference>,
  references: TableReference[],
): (TableReference & { column: string }) | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (obj.type !== "column_ref" || typeof obj.column !== "string") return null;
  if (typeof obj.table === "string") {
    const table = aliases.get(obj.table.toLowerCase());
    return table ? { ...table, column: obj.column } : null;
  }
  return references.length === 1 ? { ...references[0], column: obj.column } : null;
}

function collectJoins(
  node: unknown,
  aliases: Map<string, TableReference>,
  references: TableReference[],
  seen: Set<string>,
  joins: QueryJoin[],
): void {
  if (node == null || typeof node !== "object" || node instanceof Date) return;
  const obj = node as Record<string, unknown>;
  if (obj.type === "binary_expr" && obj.operator === "=") {
    const left = columnEndpoint(obj.left, aliases, references);
    const right = columnEndpoint(obj.right, aliases, references);
    if (left && right) {
      const a = `${left.schema ?? ""}.${left.table}.${left.column}`;
      const b = `${right.schema ?? ""}.${right.table}.${right.column}`;
      const key = [a, b].sort().join("\u0000").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        joins.push({ a: left, b: right });
      }
    }
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectJoins(item, aliases, references, seen, joins);
      }
    } else {
      collectJoins(value, aliases, references, seen, joins);
    }
  }
}

function collectColumnNames(node: unknown, names: Set<string>): void {
  if (node == null || typeof node !== "object" || node instanceof Date) return;
  const obj = node as Record<string, unknown>;
  if (
    obj.type === "column_ref" &&
    typeof obj.column === "string" &&
    obj.column !== "*"
  ) {
    names.add(obj.column);
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectColumnNames(item, names);
    } else {
      collectColumnNames(value, names);
    }
  }
}

/** Parse once before query execution. This function never touches the database. */
export function prepareCatalogQuery(sql: string): PreparedCatalogQuery {
  try {
    const ast = parser.astify(sql, { database: "mysql" });
    const references = referencesFromTableList(sql);
    const aliases = new Map<string, TableReference>();
    collectAliases(ast, aliases);
    const joins: QueryJoin[] = [];
    collectJoins(ast, aliases, references, new Set<string>(), joins);
    const columns = new Set<string>();
    collectColumnNames(ast, columns);
    return {
      references,
      normalizedSql: normalizeSql(ast),
      joins,
      columns: [...columns],
    };
  } catch {
    // Query validation remains the executor's job. A parser miss only means
    // that this request cannot teach the catalog anything.
    return { references: [], normalizedSql: null, joins: [], columns: [] };
  }
}

export function fingerprintColumnNames(sql: string): string[] | null {
  try {
    const ast = parser.astify(sql, { database: "mysql" });
    const columns = new Set<string>();
    collectColumnNames(ast, columns);
    return [...columns];
  } catch {
    return null;
  }
}

export function resultColumnNames(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) return [];
    const names = new Set<string>();
    for (const row of parsed) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      for (const name of Object.keys(row)) names.add(name);
    }
    return [...names];
  } catch {
    return [];
  }
}
