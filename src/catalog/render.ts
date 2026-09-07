import type { CatalogFile, CatalogTable } from "./types.js";

export interface SearchResult {
  table: string;
  score: number;
  comment: string;
  matchedColumns: string[];
  aliases: string[];
  notes: string[];
}

export function renderMap(catalog: CatalogFile): string {
  const schemas = Object.entries(catalog.schemas).map(([name, schema]) => ({
    app: schema.app,
    schema: name,
    description: schema.description ?? "",
    scannedAt: schema.scannedAt,
    tableCount: Object.keys(schema.tables).length,
    tables: Object.entries(schema.tables)
      .sort(([, a], [, b]) => {
        const usage = b.usage.count - a.usage.count;
        return usage || (b.rowsEstimate ?? 0) - (a.rowsEstimate ?? 0);
      })
      .slice(0, 10)
      .map(([table, entry]) => ({
        table,
        rowsEstimate: entry.rowsEstimate,
        usageCount: entry.usage.count,
      })),
  }));
  const unlinkedTables = catalog.docs.repo
    ? Object.entries(catalog.schemas).flatMap(([schemaName, schema]) =>
        Object.entries(schema.tables)
          .filter(([, table]) =>
            !Object.prototype.hasOwnProperty.call(table.curated, "doc"),
          )
          .map(([tableName]) => `${schemaName}.${tableName}`),
      )
    : [];
  return JSON.stringify(
    {
      profile: catalog.profile,
      schemas,
      unlinkedTables,
      unlinkedDocuments: catalog.docs.unlinked,
    },
    null,
    2,
  );
}

function matchScore(value: string, query: string, base: number): number {
  const candidate = value.toLowerCase();
  if (candidate === query) return base + 30;
  if (candidate.startsWith(query)) return base + 20;
  if (candidate.includes(query)) return base + 10;
  return 0;
}

export function searchCatalog(
  catalog: CatalogFile,
  query: string,
  limit: number,
  isPIIColumn: (column: string) => boolean,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const [schemaName, schema] of Object.entries(catalog.schemas)) {
    for (const [tableName, table] of Object.entries(schema.tables)) {
      const qualified = `${schemaName}.${tableName}`;
      const matchedColumns = table.columns
        .filter(
          (column) =>
            !isPIIColumn(column.name) &&
            matchScore(column.name, q, 40) > 0,
        )
        .map((column) => column.name);
      let score = Math.max(
        matchScore(qualified, q, 80),
        matchScore(tableName, q, 70),
        matchScore(table.comment, q, 20),
        ...table.curated.aliases.map((alias) => matchScore(alias, q, 60)),
        ...table.curated.notes.map((note) => matchScore(note, q, 10)),
        ...matchedColumns.map((column) => matchScore(column, q, 40)),
      );
      if (score === 0) continue;
      score += Math.min(9, Math.floor(Math.log2(table.usage.count + 1)));
      results.push({
        table: qualified,
        score,
        comment: table.comment,
        matchedColumns,
        aliases: table.curated.aliases,
        notes: table.curated.notes,
      });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.table.localeCompare(b.table))
    .slice(0, limit);
}

function safeTable(
  table: CatalogTable,
  isPIIColumn: (column: string) => boolean,
): Omit<CatalogTable, "usage"> & {
  usage: Omit<CatalogTable["usage"], "fingerprints">;
} {
  const { fingerprints: _fingerprints, ...usage } = table.usage;
  return {
    ...table,
    columns: table.columns.filter((column) => !isPIIColumn(column.name)),
    pk: table.pk.filter((column) => !isPIIColumn(column)),
    indexes: table.indexes
      .map((index) => ({
        ...index,
        columns: index.columns.filter((column) => !isPIIColumn(column)),
      }))
      .filter((index) => index.columns.length > 0),
    fks: table.fks.filter(
      (fk) =>
        !isPIIColumn(fk.column) && !isPIIColumn(fk.referencedColumn),
    ),
    usage: {
      ...usage,
      columns: Object.fromEntries(
        Object.entries(table.usage.columns).filter(
          ([column]) => !isPIIColumn(column),
        ),
      ),
    },
  };
}

export function renderDescribe(
  qualifiedName: string,
  table: CatalogTable,
  isPIIColumn: (column: string) => boolean,
): string {
  return JSON.stringify(
    { table: qualifiedName, ...safeTable(table, isPIIColumn) },
    null,
    2,
  );
}
