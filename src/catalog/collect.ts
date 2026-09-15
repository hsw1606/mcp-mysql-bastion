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
}

/**
 * `pending`이 끝난 뒤에 `run`을 시작한다. 진행 중인 작업이 없으면 바로 시작한다.
 *
 * force 수집은 호출자가 낡았다고 판단한 스냅샷에서 빠져나오려고 쓴다. 그러므로
 * 이미 돌고 있는 일반 스캔에 합류하면 목적이 무너진다. 그 스캔은 호출자가 보려는
 * migration보다 먼저 DB를 읽었고, 그 답에 방금 수집했다는 도장을 찍으면 틀린 값이
 * 그대로 굳는다. 경쟁시키지 않고 줄을 세우면 테이블마다 writer가 하나로 유지되므로,
 * force 결과가 언제나 마지막에 남는다. 앞선 실패는 삼킨다. 그것은 이전 호출자가
 * 보고할 몫이지 이번 호출자의 몫이 아니다.
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
  // 파싱할 수 없는 타임스탬프는 만료로 본다. 절대 신선한 값으로 보지 않는다.
  // NaN과의 비교는 모두 false라서, 그 결과를 그대로 돌려주면 항목이 영영 유효한
  // 것으로 굳고 테이블은 다시 스캔되지 않는다.
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
    // `information_schema`는 스키마 이름을 대소문자 구분 없이 비교한다. 그래서 위
    // SQL은 MYSQL_APP_SCHEMAS에 적힌 것과 철자가 다른 행도 가져온다. 정확히
    // 비교하지 말고 선언된 철자를 기준으로 묶어야 한다. 그러지 않으면 그런 행이
    // 여기서 전부 버려지고, 스키마는 TTL 내내 비어 있는 것으로 캐시된다.
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
    // 선언한 스키마가 비어 있다면 대개 MYSQL_APP_SCHEMAS의 오타이거나 터널 계정에
    // 권한이 없는 경우다. TTL이 끝날 때까지 조용히 빈 값을 캐시하지 말고 알린다.
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
      .filter((row) => row.kind === "column")
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
      if (row.kind !== "index" || !row.index_column) continue;
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
          Boolean(row.fk_column && row.ref_schema && row.ref_table && row.ref_column),
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
