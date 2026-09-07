import type { CatalogFile, CatalogJoin, CatalogTable } from "./types.js";

// `map` is an overview. Both unlinked lists grow with the schema — 164 tables
// and 91 documents on a cold catalog — so they are sampled and counted rather
// than emitted whole. describe and docs_list give the per-table detail.
const UNLINKED_SAMPLE_LIMIT = 30;
const HOT_TABLE_LIMIT = 10;
const TOOL_DESCRIPTION_SUFFIX_LIMIT_BYTES = 2 * 1024;

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

interface RankedTable {
  app: string;
  schema: string;
  table: string;
  entry: CatalogTable;
}

function usedAt(table: CatalogTable): number {
  const parsed = Date.parse(table.usage.lastUsedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Successful reads are the primary signal and recency breaks ties. A failed
 * query means the model could not read that table, so counting attempts would
 * promote exactly the tables that answered nothing. The row estimate is a last
 * resort for the `map` overview only — the tool description drops unread tables
 * rather than guessing importance from size.
 */
function rankTables(tables: RankedTable[]): RankedTable[] {
  return tables.sort((a, b) => {
    const used = b.entry.usage.successCount - a.entry.usage.successCount;
    if (used) return used;
    const recent = usedAt(b.entry) - usedAt(a.entry);
    if (recent) return recent;
    const rows = (b.entry.rowsEstimate ?? 0) - (a.entry.rowsEstimate ?? 0);
    if (rows) return rows;
    return `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`);
  });
}

function allTables(catalog: CatalogFile): RankedTable[] {
  return Object.entries(catalog.schemas).flatMap(([schema, entry]) =>
    Object.entries(entry.tables).map(([table, tableEntry]) => ({
      app: entry.app,
      schema,
      table,
      entry: tableEntry,
    })),
  );
}

export function renderToolDescriptionSuffix(catalog: CatalogFile): string {
  const staticGuidance =
    "\n\n테이블의 도메인 규칙·상태 코드 문서가 있을 수 있다. " +
    "SQL을 쓰기 전에 mysql_catalog describe로 확인하라.";
  // Only tables a query has actually read. Seeding this from row estimates
  // filled all ten slots with the largest event and log tables — the opposite
  // of where a model should start — and that went into the tool description of
  // every session. No list is better guidance than a wrong one.
  const hot = rankTables(
    allTables(catalog).filter(({ entry }) => entry.usage.successCount > 0),
  )
    .slice(0, HOT_TABLE_LIMIT)
    .map(({ app, schema, table, entry }) => {
      const reads = entry.usage.successCount;
      const signal =
        `${reads} successful ${reads === 1 ? "query" : "queries"}` +
        (entry.usage.lastUsedAt
          ? `, last ${entry.usage.lastUsedAt.slice(0, 10)}`
          : "");
      return `\n  - ${app} -> ${schema}.${table} (${signal})`;
    });
  if (hot.length === 0) return staticGuidance;

  const heading =
    "\n\nCATALOG HOT TABLES (most successful queries first, " +
    "recency breaks ties):";
  let suffix = heading;
  for (const line of hot) {
    if (
      Buffer.byteLength(suffix + line + staticGuidance, "utf8") >
      TOOL_DESCRIPTION_SUFFIX_LIMIT_BYTES
    ) {
      break;
    }
    suffix += line;
  }
  return suffix + staticGuidance;
}

export function renderMap(catalog: CatalogFile, warning: string | null = null): string {
  const schemas = Object.entries(catalog.schemas).map(([name, schema]) => ({
    app: schema.app,
    schema: name,
    description: schema.description ?? "",
    scannedAt: schema.scannedAt,
    tableCount: Object.keys(schema.tables).length,
    tables: rankTables(
      Object.entries(schema.tables).map(([table, entry]) => ({
        app: schema.app,
        schema: name,
        table,
        entry,
      })),
    )
      .slice(0, 10)
      .map(({ table, entry }) => ({
        table,
        rowsEstimate: entry.rowsEstimate,
        usageCount: entry.usage.count,
        successCount: entry.usage.successCount,
        lastUsedAt: entry.usage.lastUsedAt,
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
      score += Math.min(9, Math.floor(Math.log2(table.usage.successCount + 1)));
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

/**
 * The column of a `schema.table.column` join endpoint. Joins reach the catalog
 * already filtered, but every other field of `describe` is filtered again here:
 * persistence and response are meant to be two independent PII boundaries, so
 * a future writer that skips the first one cannot leak through this path.
 */
function joinEndpointColumn(endpoint: string): string {
  return endpoint.slice(endpoint.lastIndexOf(".") + 1);
}

function safeTable(
  table: CatalogTable,
  isPIIColumn: (column: string) => boolean,
): CatalogTable {
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
      ...table.usage,
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
  observedJoins: CatalogJoin[],
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
  const joins = observedJoins.filter(
    (edge) =>
      !isPIIColumn(joinEndpointColumn(edge.a)) &&
      !isPIIColumn(joinEndpointColumn(edge.b)),
  );
  return JSON.stringify(
    {
      table: qualifiedName,
      ...safeTable(table, isPIIColumn),
      ...(joins.length > 0 ? { observedJoins: joins } : {}),
      docs,
      ...(documents.warning ? { warning: documents.warning } : {}),
    },
    null,
    2,
  );
}
