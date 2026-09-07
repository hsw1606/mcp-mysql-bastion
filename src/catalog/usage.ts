import SqlParser, { type AST } from "node-sql-parser";
import type {
  PreparedCatalogQuery,
  QueryJoin,
  TableReference,
} from "./types.js";

const { Parser } = SqlParser;
const parser = new Parser();

function cteNames(ast: AST | AST[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object" || node instanceof Date) return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.with)) {
      for (const entry of obj.with) {
        if (!entry || typeof entry !== "object") continue;
        const name = (entry as Record<string, unknown>).name;
        if (name && typeof name === "object") {
          const value = (name as Record<string, unknown>).value;
          if (typeof value === "string") names.add(value.toLowerCase());
        }
      }
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  };
  visit(ast);
  return names;
}

function referencesFromTableList(
  sql: string,
  commonTableExpressions: ReadonlySet<string>,
): TableReference[] {
  const seen = new Set<string>();
  const references: TableReference[] = [];
  for (const encoded of parser.tableList(sql, { database: "mysql" })) {
    const parts = encoded.split("::");
    const schema = parts[1] && parts[1] !== "null" ? parts[1] : null;
    const table = parts.slice(2).join("::");
    if (!table) continue;
    // node-sql-parser includes CTE names in tableList. They are query-local
    // result sets, not database tables, and must not trigger inventory refreshes
    // or usage records for an unrelated table with the same name.
    if (!schema && commonTableExpressions.has(table.toLowerCase())) continue;
    const key = `${schema ?? ""}.${table}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ schema, table });
  }
  return references;
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

/** Parse once before query execution. This function never touches the database. */
export function prepareCatalogQuery(sql: string): PreparedCatalogQuery {
  try {
    const ast = parser.astify(sql, { database: "mysql" });
    const references = referencesFromTableList(sql, cteNames(ast));
    const aliases = new Map<string, TableReference>();
    collectAliases(ast, aliases);
    const joins: QueryJoin[] = [];
    collectJoins(ast, aliases, references, new Set<string>(), joins);
    return { references, joins };
  } catch {
    // Query validation remains the executor's job. A parser miss only means
    // that this request cannot teach the catalog anything.
    return { references: [], joins: [] };
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
