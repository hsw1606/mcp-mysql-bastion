import { executeQuery } from "../db/index.js";
import type { CatalogStore } from "./store.js";
import type {
  CatalogColumn,
  CatalogForeignKey,
  CatalogIndex,
  DetailRow,
  InventoryRow,
} from "./types.js";
import { emptyTable, normalizeName } from "./types.js";

export interface CatalogCollectorOptions {
  schemas: readonly string[];
  ttlHours: number;
  isPIIColumn: (column: string) => boolean;
}

/**
 * Start `run` once `pending` settles, or immediately when nothing is in flight.
 *
 * A forced collection exists to escape a snapshot the caller knows is stale, so
 * joining an unforced scan already in flight defeats it: that scan read the
 * database before the migration the caller is trying to see, and stamping its
 * answer as freshly collected pins the lie. Queueing rather than racing keeps a
 * single writer per table, so the forced result is always the one that lands
 * last. The earlier failure is swallowed because it is the previous caller's to
 * report, not this one's.
 */
function chainAfter(
  pending: Promise<void> | null | undefined,
  run: () => Promise<void>,
): Promise<void> {
  if (!pending) return run();
  return pending.catch(() => undefined).then(run);
}

function isExpired(value: string | null, ttlHours: number): boolean {
  if (!value) return true;
  const parsed = Date.parse(value);
  // A timestamp we cannot parse counts as expired, never as fresh. Every
  // comparison against NaN is false, so returning that result would pin the
  // entry as valid forever and the table would never be rescanned.
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed >= ttlHours * 60 * 60 * 1_000;
}

export class CatalogCollector {
  private inventoryPromise: Promise<void> | null = null;
  private readonly detailPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly store: CatalogStore,
    private readonly options: CatalogCollectorOptions,
  ) {}

  inventoryNeedsRefresh(): boolean {
    return this.options.schemas.some((name) => {
      const state = this.store.schemaState(name);
      return !state || isExpired(state.scannedAt, this.options.ttlHours);
    });
  }

  async collectInventory(force = false): Promise<void> {
    if (!this.store.isEnabled() || this.options.schemas.length === 0) return;
    if (!force && !this.inventoryNeedsRefresh()) return;
    const pending = this.inventoryPromise;
    if (pending && !force) return pending;
    const promise = chainAfter(pending, () => this.runInventory()).finally(() => {
      if (this.inventoryPromise === promise) this.inventoryPromise = null;
    });
    this.inventoryPromise = promise;
    return promise;
  }

  private async runInventory(): Promise<void> {
    const placeholders = this.options.schemas.map(() => "?").join(", ");
    const rows = await executeQuery<InventoryRow[]>(
      `SELECT
         table_schema AS \`table_schema\`,
         table_name AS \`table_name\`,
         table_comment AS \`table_comment\`,
         table_rows AS \`table_rows\`
       FROM information_schema.tables
       WHERE table_schema IN (${placeholders})
       ORDER BY table_schema, table_name`,
      [...this.options.schemas],
    );
    // `information_schema` compares schema names case-insensitively, so the
    // SQL above matches rows whose spelling differs from the declaration in
    // MYSQL_APP_SCHEMAS. Group by the declared spelling instead of comparing
    // exactly, or every such row is dropped here and the schema is cached as
    // empty for a full TTL.
    const declaredBySchema = new Map(
      this.options.schemas.map((name) => [normalizeName(name), name]),
    );
    const rowsBySchema = new Map<string, InventoryRow[]>();
    for (const row of rows) {
      const declared = declaredBySchema.get(normalizeName(String(row.table_schema)));
      if (!declared) continue;
      const bucket = rowsBySchema.get(declared);
      if (bucket) bucket.push(row);
      else rowsBySchema.set(declared, [row]);
    }
    const now = new Date().toISOString();
    this.store.update((catalog) => {
      for (const schemaName of this.options.schemas) {
        const schema = catalog.schemas[schemaName];
        if (!schema) continue;
        const nextTables = Object.fromEntries(
          (rowsBySchema.get(schemaName) ?? []).map((row) => {
            const existing = schema.tables[row.table_name] ?? emptyTable();
            const numericRows = Number(row.table_rows);
            return [
              row.table_name,
              {
                ...existing,
                comment: row.table_comment ?? "",
                rowsEstimate: Number.isFinite(numericRows) ? numericRows : null,
              },
            ];
          }),
        );
        schema.tables = nextTables;
        schema.scannedAt = now;
      }
    });
    // An empty declared schema is almost always a typo in MYSQL_APP_SCHEMAS or
    // a permission the tunnel user lacks. Say so instead of silently caching
    // nothing for the rest of the TTL.
    for (const schemaName of this.options.schemas) {
      if (!rowsBySchema.has(schemaName)) {
        console.error(
          `[catalog] declared schema "${schemaName}" returned no tables; check MYSQL_APP_SCHEMAS and the account's grants.`,
        );
      }
    }
    console.error(
      `[catalog] inventory scan complete: ${this.options.schemas.length} schemas, ${rows.length} tables`,
    );
  }

  detailNeedsRefresh(schemaName: string, tableName: string): boolean {
    const meta = this.store.tableMeta(schemaName, tableName);
    return Boolean(
      meta &&
        (meta.detailStale ||
          isExpired(meta.detailScannedAt, this.options.ttlHours)),
    );
  }

  async collectTableDetail(
    schemaName: string,
    tableName: string,
    force = false,
  ): Promise<void> {
    if (!this.store.isEnabled()) return;
    if (!force && !this.detailNeedsRefresh(schemaName, tableName)) return;
    const key = `${schemaName}.${tableName}`;
    const pending = this.detailPromises.get(key);
    if (pending && !force) return pending;
    const promise = chainAfter(pending, () =>
      this.runTableDetail(schemaName, tableName),
    ).finally(() => {
      if (this.detailPromises.get(key) === promise) {
        this.detailPromises.delete(key);
      }
    });
    this.detailPromises.set(key, promise);
    return promise;
  }

  private async runTableDetail(
    schemaName: string,
    tableName: string,
  ): Promise<void> {
    const rows = await executeQuery<DetailRow[]>(
      `SELECT
         'column' AS kind,
         c.column_name AS name,
         c.data_type AS \`data_type\`,
         c.column_type AS \`column_type\`,
         c.is_nullable AS \`is_nullable\`,
         CAST(c.column_default AS CHAR) AS default_value,
         c.extra AS \`extra\`,
         c.column_comment AS comment,
         c.ordinal_position AS position,
         NULL AS index_column,
         NULL AS non_unique,
         NULL AS index_type,
         NULL AS fk_column,
         NULL AS ref_schema,
         NULL AS ref_table,
         NULL AS ref_column
       FROM information_schema.columns c
       WHERE c.table_schema = ? AND c.table_name = ?
       UNION ALL
       SELECT
         'index', s.index_name, NULL, NULL, NULL, NULL, NULL, NULL,
         s.seq_in_index, s.column_name, s.non_unique, s.index_type,
         NULL, NULL, NULL, NULL
       FROM information_schema.statistics s
       WHERE s.table_schema = ? AND s.table_name = ?
       UNION ALL
       SELECT
         'fk', k.constraint_name, NULL, NULL, NULL, NULL, NULL, NULL,
         k.ordinal_position, NULL, NULL, NULL,
         k.column_name, k.referenced_table_schema,
         k.referenced_table_name, k.referenced_column_name
       FROM information_schema.key_column_usage k
       WHERE k.table_schema = ? AND k.table_name = ?
         AND k.referenced_table_name IS NOT NULL
       ORDER BY kind, position`,
      [schemaName, tableName, schemaName, tableName, schemaName, tableName],
    );

    const columns: CatalogColumn[] = rows
      .filter(
        (row) =>
          row.kind === "column" && !this.options.isPIIColumn(row.name),
      )
      .map((row) => ({
        name: row.name,
        dataType: row.data_type ?? "",
        columnType: row.column_type ?? "",
        nullable: row.is_nullable === "YES",
        defaultValue: row.default_value,
        extra: row.extra ?? "",
        comment: row.comment ?? "",
        ordinal: Number(row.position),
      }));

    const indexesByName = new Map<string, CatalogIndex>();
    for (const row of rows) {
      if (
        row.kind !== "index" ||
        !row.index_column ||
        this.options.isPIIColumn(row.index_column)
      ) {
        continue;
      }
      const index = indexesByName.get(row.name) ?? {
        name: row.name,
        unique: Number(row.non_unique) === 0,
        type: row.index_type ?? "",
        columns: [],
      };
      index.columns.push(row.index_column);
      indexesByName.set(row.name, index);
    }
    const indexes = [...indexesByName.values()];
    const pk = indexes.find((index) => index.name === "PRIMARY")?.columns ?? [];

    const fks: CatalogForeignKey[] = rows
      .filter(
        (row) =>
          row.kind === "fk" &&
          Boolean(row.fk_column && row.ref_schema && row.ref_table && row.ref_column) &&
          !this.options.isPIIColumn(row.fk_column as string) &&
          !this.options.isPIIColumn(row.ref_column as string),
      )
      .map((row) => ({
        name: row.name,
        column: row.fk_column as string,
        referencedSchema: row.ref_schema as string,
        referencedTable: row.ref_table as string,
        referencedColumn: row.ref_column as string,
      }));

    this.store.update((catalog) => {
      const table = catalog.schemas[schemaName]?.tables[tableName];
      if (!table) return;
      table.columns = columns;
      table.pk = pk;
      table.indexes = indexes;
      table.fks = fks;
      table.detailScannedAt = new Date().toISOString();
      delete table.detailStale;
    });
    console.error(
      `[catalog] detail scan complete: ${schemaName}.${tableName} (${columns.length} columns)`,
    );
  }
}
