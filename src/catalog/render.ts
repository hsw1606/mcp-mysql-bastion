import type { CatalogFile, CatalogJoin, CatalogTable } from "./types.js";

// `map` is an overview. Both unlinked lists grow with the schema — 164 tables
// and 91 documents on a cold catalog — so they are sampled and counted rather
// than emitted whole. describe and docs_list give the per-table detail.
const UNLINKED_SAMPLE_LIMIT = 30;
const HOT_TABLE_LIMIT = 10;

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

/**
 * The tail of the `mysql_query` tool description, built to fit `budget`
 * characters.
 *
 * The budget is what the base description left over, because a client that
 * caps tool descriptions cuts from the end and says nothing — so overflowing
 * here does not lose the least important text, it loses whatever happens to be
 * last. Counting characters rather than bytes is what the cap is stated in;
 * measuring this Korean guidance in UTF-8 bytes would price it at three times
 * what it costs.
 *
 * Guidance outranks the table list: one is an instruction, the other is a
 * starting hint that `mysql_catalog map` gives in full anyway.
 */
export function renderToolDescriptionSuffix(
  catalog: CatalogFile,
  budget: number,
): string {
  const staticGuidance =
    "\n\n테이블의 도메인 규칙·상태 코드 문서가 있을 수 있다. " +
    "SQL을 쓰기 전에 mysql_catalog describe로 확인하라.";
  if (staticGuidance.length > budget) return "";

  // Only tables a query has actually read. Seeding this from row estimates
  // filled all ten slots with the largest event and log tables — the opposite
  // of where a model should start — and that went into the tool description of
  // every session. No list is better guidance than a wrong one.
  //
  // Names only. The read count and date that used to follow each name ranked
  // the list, and the list is already in that order; spelling the ranking out
  // cost about 55 characters a table for something the order says. `map`
  // still reports both for anyone who wants to see the ranking itself.
  const hot = rankTables(
    allTables(catalog).filter(({ entry }) => entry.usage.successCount > 0),
  )
    .slice(0, HOT_TABLE_LIMIT)
    .map(({ schema, table }) => `${schema}.${table}`);
  if (hot.length === 0) return staticGuidance;

  const heading = "\n\nCATALOG HOT TABLES (most read first): ";
  let listed = "";
  for (const name of hot) {
    const next = listed ? `${listed}, ${name}` : name;
    if ((heading + next + staticGuidance).length > budget) break;
    listed = next;
  }
  // A heading with nothing under it is noise, and it is the case where even
  // the first name did not fit.
  if (!listed) return staticGuidance;
  return heading + listed + staticGuidance;
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
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const [schemaName, schema] of Object.entries(catalog.schemas)) {
    for (const [tableName, table] of Object.entries(schema.tables)) {
      const qualified = `${schemaName}.${tableName}`;
      const matchedColumns = table.columns
        .filter((column) => matchScore(column.name, q, 40) > 0)
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

export function renderDescribe(
  qualifiedName: string,
  table: CatalogTable,
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
  return JSON.stringify(
    {
      table: qualifiedName,
      ...table,
      ...(observedJoins.length > 0 ? { observedJoins } : {}),
      docs,
      ...(documents.warning ? { warning: documents.warning } : {}),
    },
    null,
    2,
  );
}
