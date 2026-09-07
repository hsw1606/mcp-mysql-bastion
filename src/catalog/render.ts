import type { CatalogFile, CatalogTable } from "./types.js";

// `map` is an overview. Both unlinked lists grow with the schema — 164 tables
// and 91 documents on a cold catalog — so they are sampled and counted rather
// than emitted whole. describe and docs_list give the per-table detail.
const UNLINKED_SAMPLE_LIMIT = 30;

function sampled(values: string[]): {
  total: number;
  sample: string[];
  truncated?: true;
} {
  const sample = values.slice(0, UNLINKED_SAMPLE_LIMIT);
  return {
    total: values.length,
    sample,
    ...(values.length > sample.length ? { truncated: true as const } : {}),
  };
}

export interface SearchResult {
  table: string;
  score: number;
  comment: string;
  matchedColumns: string[];
  aliases: string[];
  notes: string[];
}

export function renderMap(catalog: CatalogFile, warning: string | null = null): string {
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
      unlinkedTables: sampled(unlinkedTables),
      unlinkedDocuments: sampled(catalog.docs.unlinked),
      ...(warning ? { warning } : {}),
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
  documents: {
    configured: boolean;
    available: boolean;
    ref: string | null;
    command: string | null;
    warning: string | null;
    schema: string;
  },
): string {
  let docs: unknown;
  const hasDocumentDecision = Object.prototype.hasOwnProperty.call(
    table.curated,
    "doc",
  );
  const documentLink = table.curated.doc;
  if (!documents.configured) {
    docs = "문서 축 비활성 (MYSQL_DOCS_REPO 미설정)";
  } else if (!documents.available) {
    docs = "문서 축 비활성";
  } else if (!hasDocumentDecision) {
    docs =
      "연결 안 됨\n" +
      `후보를 보려면 mysql_catalog {action:"docs_list", schema:"${documents.schema}"}\n` +
      "status 같은 코드 컬럼의 의미는 도메인 문서에만 있습니다.";
  } else if (documentLink == null) {
    docs = "문서 없음 확인됨";
  } else {
    docs = {
      path: documentLink.path,
      ref: documents.ref,
      command: documents.command,
      guidance: "상태 코드·도메인 규칙은 이 문서를 먼저 읽어라.",
    };
  }
  return JSON.stringify(
    {
      table: qualifiedName,
      ...safeTable(table, isPIIColumn),
      docs,
      ...(documents.warning ? { warning: documents.warning } : {}),
    },
    null,
    2,
  );
}
