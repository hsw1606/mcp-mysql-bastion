import type { CatalogFile, CatalogJoin, CatalogTable } from "./types.js";

// `map`은 개요다. 연결 안 된 목록 둘은 스키마를 따라 자란다 — 갓 만든 카탈로그에서
// 테이블 164개, 문서 91개다 — 그래서 통째로 내보내지 않고 표본과 개수만 준다.
// 테이블별 상세는 describe와 docs_list가 준다.
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
 * 성공한 읽기가 주된 신호이고, 동점은 최근성으로 가른다. 실패한 쿼리는 모델이 그
 * 테이블을 읽지 못했다는 뜻이다. 그래서 시도 횟수를 세면 아무것도 답하지 못한 테이블이
 * 오히려 위로 올라온다. 행 추정치는 `map` 개요에서만 쓰는 최후의 수단이다 — 도구
 * 설명은 크기로 중요도를 짐작하는 대신 읽힌 적 없는 테이블을 아예 뺀다.
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
 * `mysql_query` 도구 설명의 꼬리 부분. `budget` 글자 수에 맞춰 만든다.
 *
 * 예산은 기본 설명이 쓰고 남긴 몫이다. 도구 설명에 상한을 두는 클라이언트는 아무 말
 * 없이 뒤에서부터 자르기 때문이다 — 그래서 여기서 넘치면 덜 중요한 글이 아니라 그저
 * 맨 뒤에 놓인 글이 사라진다. 바이트가 아니라 글자로 세는 것은 상한 자체가 글자 수로
 * 쓰여 있어서다. 이 한국어 안내를 UTF-8 바이트로 재면 실제 비용의 세 배로 쳐진다.
 *
 * 안내가 테이블 목록보다 우선한다. 하나는 지시이고, 다른 하나는 어차피
 * `mysql_catalog map`이 전부 알려 주는 출발점 힌트일 뿐이다.
 */
export function renderToolDescriptionSuffix(
  catalog: CatalogFile,
  budget: number,
): string {
  const staticGuidance =
    "\n\n테이블의 도메인 규칙·상태 코드 문서가 있을 수 있다. " +
    "SQL을 쓰기 전에 mysql_catalog describe로 확인하라.";
  if (staticGuidance.length > budget) return "";

  // 쿼리가 실제로 읽은 테이블만 넣는다. 행 추정치로 채웠더니 열 자리가 전부 가장 큰
  // 이벤트·로그 테이블로 찼다 — 모델이 출발해야 할 곳과 정반대다 — 그리고 그것이 모든
  // 세션의 도구 설명에 실렸다. 틀린 목록보다는 목록이 없는 편이 나은 안내다.
  //
  // 이름만 적는다. 예전에 이름 뒤에 붙던 읽은 횟수와 날짜는 목록의 순위를 매기던
  // 값인데, 목록은 이미 그 순서로 놓여 있다. 순서가 말해 주는 것을 굳이 적느라
  // 테이블마다 55자쯤을 썼다. 순위 자체를 보고 싶은 사람에게는 `map`이 여전히 둘 다
  // 알려 준다.
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
  // 아래에 아무것도 없는 제목은 잡음이다. 첫 이름조차 들어가지 못한 경우가 그렇다.
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
