import type { AppSchemaEntry } from "../types/index.js";

export const CATALOG_VERSION = 1;

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

// Observed joins are the one axis that grows without a natural bound: every
// new column pair a query equates adds an edge and nothing ever retires it.
// The bound is generous because an edge costs a single short line in the file.
export const JOIN_EDGE_LIMIT = 500;

/**
 * Cap the observed joins, dropping the least recently seen first. Recency
 * rather than count on purpose: evicting the rarest edge would turn the cap
 * into a wall that a join path discovered later could never cross.
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
  /** Missing means unreviewed, null means reviewed and no document exists. */
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
 * Small read-only facts about one table. Callers that only need these must not
 * clone the whole catalog to get them — see `CatalogStore.tableMeta`.
 */
export interface CatalogTableMeta {
  detailScannedAt: string | null;
  detailStale: boolean;
  /** True once a model or user recorded a document decision: link or unlink. */
  docReviewed: boolean;
}

/**
 * What the timeout diagnosis needs to know about one table, and nothing more.
 *
 * `detailScannedAt` and `detailStale` are carried because the diagnosis is only
 * allowed to say "no index covers this column" when the index list is known to
 * be both present and current. An unscanned or stale table must downgrade the
 * verdict instead of asserting an absence it cannot see.
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
 * What one query teaches the catalog. Nothing derived from the SQL text itself
 * belongs here: D-6 forbids the cache from holding query literals, and the
 * safest way to honour that is to never carry the statement past this point.
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
  piiRedactionEnabled: boolean;
  isPIIColumn: (column: string) => boolean;
}

/**
 * Canonical form for a schema or table name. MySQL compares identifiers
 * case-insensitively in `information_schema`, and the declared spelling in
 * `MYSQL_APP_SCHEMAS` is written by hand, so every lookup normalizes first.
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
