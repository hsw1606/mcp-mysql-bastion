import type { AppSchemaEntry } from "../types/index.js";

/**
 * 컬럼과 인덱스 이름을 카탈로그에서 걸러내는 일을 그만두면서 2로 올렸다. 아직
 * 걸러내던 빌드가 쓴 파일에는 그 항목들이 빠져 있고, 파일 어디에도 빠졌다는 기록이
 * 없다 — TTL에만 맡기면 하루 동안 짧은 컬럼 목록으로 계속 답하게 된다. 파일을 아예
 * 거부해야 그 제거가 다음 시작부터 반영된다.
 */
export const CATALOG_VERSION = 2;

export interface CatalogColumn {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  extra: string;
  comment: string;
  ordinal: number;
}

export interface CatalogIndex {
  name: string;
  unique: boolean;
  type: string;
  columns: string[];
}

export interface CatalogForeignKey {
  name: string;
  column: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface CatalogUsage {
  count: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: string | null;
  columns: Record<string, number>;
}

export interface CatalogJoin {
  a: string;
  b: string;
  count: number;
  lastUsedAt: string;
}

// 관측한 조인은 자연스러운 상한 없이 자라는 유일한 축이다. 쿼리가 새로 같다고 묶는
// 컬럼 쌍마다 간선이 하나씩 늘고, 물러나는 간선은 없다. 간선 하나가 파일에서 짧은
// 한 줄이면 되므로 상한은 넉넉하게 잡았다.
export const JOIN_EDGE_LIMIT = 500;

/**
 * 관측한 조인에 상한을 두고, 가장 오래 못 본 것부터 버린다. 횟수가 아니라 최근성을
 * 기준으로 삼은 것은 의도적이다. 가장 드문 간선을 버리면 상한이 벽이 되어, 나중에
 * 발견한 조인 경로는 영영 넘어오지 못한다.
 */
export function pruneJoins(joins: CatalogJoin[]): CatalogJoin[] {
  if (joins.length <= JOIN_EDGE_LIMIT) return joins;
  return [...joins]
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, JOIN_EDGE_LIMIT);
}

export type CatalogForgetScope =
  | "notes"
  | "aliases"
  | "usage"
  | "joins"
  | "metadata";

export interface CatalogDocumentLink {
  path: string;
  linkedBy: "model" | "user";
  linkedAt: string;
  linkedAtCommit: string | null;
}

export interface CatalogCurated {
  notes: string[];
  aliases: string[];
  /** 키가 없으면 아직 검토 전, null이면 검토했고 문서가 없다는 뜻이다. */
  doc?: CatalogDocumentLink | null;
}

export interface CatalogTable {
  comment: string;
  rowsEstimate: number | null;
  detailScannedAt: string | null;
  detailStale?: boolean;
  columns: CatalogColumn[];
  pk: string[];
  indexes: CatalogIndex[];
  fks: CatalogForeignKey[];
  usage: CatalogUsage;
  curated: CatalogCurated;
}

/**
 * 테이블 하나에 대한 작고 읽기 전용인 사실들. 이것만 필요한 호출자가 이를 얻자고
 * 카탈로그 전체를 복제해서는 안 된다 — `CatalogStore.tableMeta`를 보라.
 */
export interface CatalogTableMeta {
  detailScannedAt: string | null;
  detailStale: boolean;
  /** 모델이나 사용자가 문서 연결 또는 해제를 기록했으면 true다. */
  docReviewed: boolean;
}

/**
 * 타임아웃 진단이 테이블 하나에 대해 알아야 하는 것, 딱 거기까지.
 *
 * `detailScannedAt`과 `detailStale`을 함께 들고 다니는 이유가 있다. 진단은 인덱스
 * 목록이 있고 또 최신이라고 확인될 때만 "이 컬럼을 덮는 인덱스가 없다"고 말할 수 있다.
 * 스캔하지 않았거나 낡은 테이블이면, 보지도 못한 부재를 단정하는 대신 판정을 낮춰야
 * 한다.
 */
export interface CatalogIndexFacts {
  schema: string;
  table: string;
  indexes: CatalogIndex[];
  pk: string[];
  rowsEstimate: number | null;
  detailScannedAt: string | null;
  detailStale: boolean;
}

export interface CatalogSchema {
  app: string;
  description?: string;
  scannedAt: string | null;
  tables: Record<string, CatalogTable>;
}

export interface CatalogDocs {
  repo: string | null;
  ref: string | null;
  refCommit: string | null;
  refUpdatedAt: string | null;
  paths: string[];
  unlinked: string[];
}

export interface CatalogFile {
  version: typeof CATALOG_VERSION;
  profile: string;
  fingerprint: string;
  docs: CatalogDocs;
  schemas: Record<string, CatalogSchema>;
  joins: CatalogJoin[];
}

export interface InventoryRow {
  table_schema: string;
  table_name: string;
  table_comment: string | null;
  table_rows: number | string | null;
}

export interface DetailRow {
  kind: "column" | "index" | "fk";
  name: string;
  data_type: string | null;
  column_type: string | null;
  is_nullable: string | null;
  default_value: string | null;
  extra: string | null;
  comment: string | null;
  position: number | string | null;
  index_column: string | null;
  non_unique: number | string | null;
  index_type: string | null;
  fk_column: string | null;
  ref_schema: string | null;
  ref_table: string | null;
  ref_column: string | null;
}

export interface TableReference {
  schema: string | null;
  table: string;
}

export interface QueryJoin {
  a: TableReference & { column: string };
  b: TableReference & { column: string };
}

/**
 * 쿼리 하나가 카탈로그에 알려 주는 것. SQL 텍스트 자체에서 끌어낸 것은 여기 들어오지
 * 않는다. D-6은 캐시가 쿼리 리터럴을 들고 있는 것을 금지하고, 그 약속을 지키는 가장
 * 안전한 방법은 문장을 이 지점 너머로 넘기지 않는 것이다.
 */
export interface PreparedCatalogQuery {
  references: TableReference[];
  joins: QueryJoin[];
}

export interface CatalogOptions {
  enabled: boolean;
  profile: string;
  fingerprint: string;
  filePath: string;
  ttlHours: number;
  appSchemas: readonly AppSchemaEntry[];
  docsRepo: string | null;
  docsRef: string | null;
  defaultSchema: string | null;
}

/**
 * 스키마나 테이블 이름의 정규형. MySQL은 `information_schema`에서 식별자를 대소문자
 * 구분 없이 비교하고, `MYSQL_APP_SCHEMAS`에 적힌 철자는 사람이 손으로 쓴 것이다.
 * 그래서 모든 조회는 정규화부터 한다.
 */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function emptyTable(): CatalogTable {
  return {
    comment: "",
    rowsEstimate: null,
    detailScannedAt: null,
    columns: [],
    pk: [],
    indexes: [],
    fks: [],
    usage: emptyUsage(),
    curated: { notes: [], aliases: [] },
  };
}

export function emptyUsage(): CatalogUsage {
  return {
    count: 0,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: null,
    columns: {},
  };
}

export function emptyCatalog(options: CatalogOptions): CatalogFile {
  const schemas: Record<string, CatalogSchema> = {};
  for (const entry of options.appSchemas) {
    schemas[entry.schema] = {
      app: entry.app,
      ...(entry.description ? { description: entry.description } : {}),
      scannedAt: null,
      tables: {},
    };
  }
  return {
    version: CATALOG_VERSION,
    profile: options.profile,
    fingerprint: options.fingerprint,
    docs: {
      repo: options.docsRepo,
      ref: options.docsRef,
      refCommit: null,
      refUpdatedAt: null,
      paths: [],
      unlinked: [],
    },
    schemas,
    joins: [],
  };
}
