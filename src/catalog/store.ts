import * as fs from "fs";
import * as path from "path";
import type {
  CatalogCurated,
  CatalogDocs,
  CatalogFile,
  CatalogIndexFacts,
  CatalogJoin,
  CatalogOptions,
  CatalogSchema,
  CatalogTable,
  CatalogTableMeta,
} from "./types.js";
import {
  CATALOG_VERSION,
  emptyCatalog,
  emptyTable,
  normalizeName,
  pruneJoins,
} from "./types.js";

const FLUSH_DELAY_MS = 2_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 15_000;
// 종료할 때는 전체 대기 시간을 감당할 수 없다. stdin을 닫은 클라이언트는 이미 떠났고,
// 여기서 오래 붙들고 있으면 SSH 터널을 내리기도 전에 프로세스가 죽을 수 있다.
const LOCK_CLOSE_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const CLOSE_FLUSH_ATTEMPTS = 2;

/**
 * 다른 writer가 대기 시간 내내 락을 쥐고 있을 때 던진다. 그 자체로 복구할 수 있는
 * 상황이다. 깨진 데이터는 없고 아직 flush하지 않은 리비전도 메모리에 그대로 있으니,
 * 호출자는 카탈로그를 꺼 버리는 대신 다시 시도한다.
 */
class CatalogLockTimeoutError extends Error {}

interface CatalogLockRecord {
  pid: number;
  token: string;
  createdAt: number;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCatalogLock(
  filePath: string,
  waitMs: number,
): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + waitMs;
  const record: CatalogLockRecord = {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
  };

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        try {
          const current = JSON.parse(
            await fs.promises.readFile(lockPath, "utf8"),
          ) as Partial<CatalogLockRecord>;
          if (current.token === record.token) {
            await fs.promises.unlink(lockPath);
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;

      let lockText: string | null = null;
      let stale = false;
      try {
        const [text, stat] = await Promise.all([
          fs.promises.readFile(lockPath, "utf8"),
          fs.promises.stat(lockPath),
        ]);
        lockText = text;
        let owner: Partial<CatalogLockRecord> = {};
        try {
          owner = JSON.parse(text) as Partial<CatalogLockRecord>;
        } catch {
          // 새 소유자가 파일을 열어 놓고 아직 쓰기 전일 수 있다. 읽을 수 없는 락은
          // 오직 시간이 지나야 stale이 되므로, 다른 writer가 먼저 지우지 않는다.
        }
        stale =
          typeof owner.pid === "number"
            ? !processIsAlive(owner.pid)
            : Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
      } catch (readError) {
        if (errorCode(readError) === "ENOENT") continue;
        throw readError;
      }

      if (stale && lockText !== null) {
        try {
          // 지우기 전에 다시 읽는다. 위에서 살펴본 stale 락을 대신해 방금 잡힌
          // 락까지 지워 버리지 않기 위해서다.
          if ((await fs.promises.readFile(lockPath, "utf8")) === lockText) {
            await fs.promises.unlink(lockPath);
            console.error(`[catalog] removed stale lock ${lockPath}`);
            continue;
          }
        } catch (cleanupError) {
          if (errorCode(cleanupError) === "ENOENT") continue;
          throw cleanupError;
        }
      }

      if (Date.now() >= deadline) {
        throw new CatalogLockTimeoutError(
          `timed out after ${waitMs}ms waiting for catalog lock ${lockPath}`,
        );
      }
      await delay(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }
}

const EPOCH = new Date(0).toISOString();

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeEditedSet(
  external: string[],
  local: string[],
  base: string[],
): string[] {
  const merged = new Set(external);
  for (const previous of base) {
    if (!local.includes(previous)) merged.delete(previous);
  }
  for (const current of local) {
    if (!base.includes(current)) merged.add(current);
  }
  return [...merged];
}

function mergeCurated(
  external: CatalogCurated,
  local: CatalogCurated,
  base?: CatalogCurated,
): CatalogCurated {
  const baseDoc = Object.prototype.hasOwnProperty.call(base ?? {}, "doc")
    ? JSON.stringify(base?.doc)
    : "__missing__";
  const localDoc = Object.prototype.hasOwnProperty.call(local, "doc")
    ? JSON.stringify(local.doc)
    : "__missing__";
  const chosen = localDoc !== baseDoc ? local : external;
  return {
    notes: mergeEditedSet(
      external.notes ?? [],
      local.notes ?? [],
      base?.notes ?? [],
    ),
    aliases: mergeEditedSet(
      external.aliases ?? [],
      local.aliases ?? [],
      base?.aliases ?? [],
    ),
    ...(Object.prototype.hasOwnProperty.call(chosen, "doc")
      ? { doc: chosen.doc }
      : {}),
  };
}

function mergedCounter(external: number, local: number, base: number): number {
  // 로컬 값이 더 작다면 증가분을 잃은 것이 아니라 `forget`이 의도적으로 초기화한
  // 것이다. 다른 프로세스가 base 이후에 더한 증가분만 살린다.
  if (local < base) return local + Math.max(0, external - base);
  return external + Math.max(0, local - base);
}

function newerUsageTimestamp(
  externalValue: string | null | undefined,
  localValue: string | null | undefined,
  externalCount: number,
  localCount: number,
  baseCount: number,
): string | null {
  if (localCount < baseCount && externalCount <= baseCount) {
    return localValue ?? null;
  }
  if (externalCount < baseCount && localCount <= baseCount) {
    return externalValue ?? null;
  }
  return timestamp(localValue) >= timestamp(externalValue)
    ? localValue ?? null
    : externalValue ?? null;
}

function mergeTable(
  external: CatalogTable,
  local: CatalogTable,
  base?: CatalogTable,
): CatalogTable {
  const baseDetailAt = timestamp(base?.detailScannedAt);
  const localInvalidated =
    local.detailStale === true &&
    (base?.detailStale !== true || local.detailScannedAt === null);
  const externalInvalidated =
    external.detailStale === true &&
    (base?.detailStale !== true || external.detailScannedAt === null);
  const externalRefreshed = timestamp(external.detailScannedAt) > baseDetailAt;
  const localRefreshed = timestamp(local.detailScannedAt) > baseDetailAt;
  const newerDetail =
    localInvalidated && !externalRefreshed
      ? local
      : externalInvalidated && !localRefreshed
        ? external
        : timestamp(local.detailScannedAt) >= timestamp(external.detailScannedAt)
          ? local
          : external;
  const externalUsageCount = external.usage?.count ?? 0;
  const localUsageCount = local.usage?.count ?? 0;
  const baseUsageCount = base?.usage?.count ?? 0;
  const columns = [...new Set([
    ...Object.keys(external.usage?.columns ?? {}),
    ...Object.keys(local.usage?.columns ?? {}),
  ])]
    .map((column) => [
      column,
      mergedCounter(
        external.usage?.columns?.[column] ?? 0,
        local.usage?.columns?.[column] ?? 0,
        base?.usage?.columns?.[column] ?? 0,
      ),
    ] as const)
    .filter(([, count]) => count > 0);
  return {
    ...newerDetail,
    usage: {
      count: mergedCounter(externalUsageCount, localUsageCount, baseUsageCount),
      successCount: mergedCounter(
        external.usage?.successCount ?? 0,
        local.usage?.successCount ?? 0,
        base?.usage?.successCount ?? 0,
      ),
      failureCount: mergedCounter(
        external.usage?.failureCount ?? 0,
        local.usage?.failureCount ?? 0,
        base?.usage?.failureCount ?? 0,
      ),
      lastUsedAt: newerUsageTimestamp(
        external.usage?.lastUsedAt,
        local.usage?.lastUsedAt,
        externalUsageCount,
        localUsageCount,
        baseUsageCount,
      ),
      columns: Object.fromEntries(columns),
    },
    curated: mergeCurated(
      external.curated ?? { notes: [], aliases: [] },
      local.curated ?? { notes: [], aliases: [] },
      base?.curated,
    ),
  };
}

function mergeSchema(
  external: CatalogSchema,
  local: CatalogSchema,
  base?: CatalogSchema,
): CatalogSchema {
  const newerInventory =
    timestamp(local.scannedAt) >= timestamp(external.scannedAt)
      ? local
      : external;
  const olderInventory = newerInventory === local ? external : local;
  const tables: Record<string, CatalogTable> = {};
  for (const [name, table] of Object.entries(newerInventory.tables)) {
    tables[name] = olderInventory.tables[name]
      ? mergeTable(
          newerInventory === local ? olderInventory.tables[name] : table,
          newerInventory === local ? table : olderInventory.tables[name],
          base?.tables[name],
        )
      : table;
  }
  return { ...newerInventory, tables };
}

function mergeCatalog(
  external: CatalogFile,
  local: CatalogFile,
  base: CatalogFile,
): CatalogFile {
  const schemas: Record<string, CatalogSchema> = {};
  for (const name of new Set([
    ...Object.keys(external.schemas),
    ...Object.keys(local.schemas),
  ])) {
    if (external.schemas[name] && local.schemas[name]) {
      schemas[name] = mergeSchema(
        external.schemas[name],
        local.schemas[name],
        base.schemas[name],
      );
    } else {
      schemas[name] = external.schemas[name] ?? local.schemas[name];
    }
  }
  const joins = new Map<string, CatalogJoin>();
  const externalJoins = new Map(
    external.joins.map((edge) => [`${edge.a}\u0000${edge.b}`, edge]),
  );
  const localJoins = new Map(
    local.joins.map((edge) => [`${edge.a}\u0000${edge.b}`, edge]),
  );
  const baseJoins = new Map(
    base.joins.map((edge) => [`${edge.a}\u0000${edge.b}`, edge]),
  );
  for (const key of new Set([...externalJoins.keys(), ...localJoins.keys()])) {
    const outside = externalJoins.get(key);
    const inside = localJoins.get(key);
    const ancestor = baseJoins.get(key);
    const edge = outside ?? inside;
    if (!edge) continue;
    const count = mergedCounter(
      outside?.count ?? 0,
      inside?.count ?? 0,
      ancestor?.count ?? 0,
    );
    if (count <= 0) continue;
    joins.set(key, {
      a: edge.a,
      b: edge.b,
      count,
      lastUsedAt:
        newerUsageTimestamp(
          outside?.lastUsedAt,
          inside?.lastUsedAt,
          outside?.count ?? 0,
          inside?.count ?? 0,
          ancestor?.count ?? 0,
        ) ?? EPOCH,
    });
  }
  const localDocsChanged = local.docs.refCommit !== base.docs.refCommit;
  const externalDocsChanged = external.docs.refCommit !== base.docs.refCommit;
  const chosenDocs =
    localDocsChanged && externalDocsChanged
      ? timestamp(local.docs.refUpdatedAt) >= timestamp(external.docs.refUpdatedAt)
        ? local.docs
        : external.docs
      : localDocsChanged
        ? local.docs
        : external.docs;
  const merged: CatalogFile = {
    ...local,
    docs: {
      ...chosenDocs,
      repo: local.docs.repo,
      ref: local.docs.ref,
      paths: chosenDocs.paths ?? [],
      unlinked: [],
    },
    schemas,
    // 각자 상한 아래였던 writer 둘이 병합되면 상한을 넘길 수 있다.
    joins: pruneJoins([...joins.values()]),
  };
  const linked = new Set<string>();
  for (const schema of Object.values(merged.schemas)) {
    for (const table of Object.values(schema.tables)) {
      if (table.curated.doc && !merged.docs.paths.includes(table.curated.doc.path)) {
        delete table.curated.doc;
      }
      if (table.curated.doc) linked.add(table.curated.doc.path);
    }
  }
  merged.docs.unlinked = merged.docs.paths.filter((path) => !linked.has(path));
  return merged;
}

export class CatalogStore {
  private enabled: boolean;
  private data: CatalogFile;
  private baseData: CatalogFile;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private revision = 0;
  private flushedRevision = 0;
  private closing = false;
  /** 대소문자를 가리지 않는 이름 조회용 인덱스. 변경 후 필요해질 때 다시 만든다. */
  private nameIndex: Map<
    string,
    { schema: string; tables: Map<string, string> }
  > | null = null;

  constructor(private readonly options: CatalogOptions) {
    this.enabled = options.enabled;
    this.data = emptyCatalog(options);
    this.baseData = structuredClone(this.data);
    if (this.enabled) this.initialize();
  }

  private initialize(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.filePath), {
        recursive: true,
        mode: 0o700,
      });
      this.loadFromDisk();
    } catch (error) {
      this.disable(
        `cannot initialize ${this.options.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.options.filePath)) return;
    let parsed: Partial<CatalogFile>;
    try {
      parsed = JSON.parse(
        fs.readFileSync(this.options.filePath, "utf8"),
      ) as Partial<CatalogFile>;
    } catch (error) {
      // 읽을 수 없는 파일은 카탈로그를 끌 이유가 못 된다. 캐시가 없는 것과 같게
      // 다루면 되고, 다음 flush의 원자적 rename이 그 파일을 우리 내용으로
      // 교체한다. 카탈로그를 끄는 것은 디스크 자체를 쓸 수 없을 때뿐이다 —
      // 그쪽은 `initialize`의 mkdir이 잡는다. 같은 파일의 `readExternal`도
      // flush 경로에서 이미 이렇게 관용한다.
      console.error(
        `[catalog] ignoring unreadable ${this.options.filePath}; it will be replaced: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (
      parsed.version !== CATALOG_VERSION ||
      parsed.profile !== this.options.profile ||
      parsed.fingerprint !== this.options.fingerprint
    ) {
      console.error(
        `[catalog] ignoring incompatible cache at ${this.options.filePath}; it will be replaced.`,
      );
      return;
    }
    this.data = this.sanitizeLoaded(parsed as CatalogFile);
    this.invalidateNameIndex();
    this.baseData = structuredClone(this.data);
    this.revision += 1;
    this.scheduleFlush();
    console.error(`[catalog] loaded ${this.options.filePath}`);
  }

  private sanitizeLoaded(loaded: CatalogFile): CatalogFile {
    const fresh = emptyCatalog(this.options);
    const docsCompatible =
      loaded.docs?.repo === this.options.docsRepo &&
      loaded.docs?.ref === this.options.docsRef;
    for (const [schemaName, schema] of Object.entries(fresh.schemas)) {
      const cached = loaded.schemas?.[schemaName];
      if (!cached) continue;
      schema.scannedAt = cached.scannedAt ?? null;
      for (const [tableName, raw] of Object.entries(cached.tables ?? {})) {
        const base = emptyTable();
        const table: CatalogTable = {
          ...base,
          ...raw,
          // `?? []`는 단순한 기본값 이상의 몫을 한다. 예전 빌드가 쓴 카탈로그
          // 파일에는 이 키들이 통째로 없을 수 있는데, `tableIndexes` 같은 읽기
          // 쪽은 이들을 아무 방어 없이 순회한다.
          columns: raw.columns ?? [],
          pk: raw.pk ?? [],
          indexes: raw.indexes ?? [],
          fks: raw.fks ?? [],
          usage: {
            count: raw.usage?.count ?? 0,
            successCount: raw.usage?.successCount ?? raw.usage?.count ?? 0,
            failureCount: raw.usage?.failureCount ?? 0,
            lastUsedAt: raw.usage?.lastUsedAt ?? null,
            columns: raw.usage?.columns ?? {},
          },
          curated: {
            notes: raw.curated?.notes ?? [],
            aliases: raw.curated?.aliases ?? [],
            ...(docsCompatible &&
            Object.prototype.hasOwnProperty.call(raw.curated ?? {}, "doc")
              ? { doc: raw.curated.doc }
              : {}),
          },
        };
        schema.tables[tableName] = table;
      }
    }
    if (docsCompatible) {
      fresh.docs = {
        ...fresh.docs,
        refCommit: loaded.docs.refCommit ?? null,
        refUpdatedAt: loaded.docs.refUpdatedAt ?? null,
        paths: loaded.docs.paths ?? [],
        unlinked: loaded.docs.unlinked ?? [],
      };
    }
    fresh.joins = pruneJoins(
      (loaded.joins ?? [])
        // 간선에 시각을 찍기 전에 만들어진 캐시는 가장 먼저 밀려난다. 비교할 최근성
        // 정보가 없고, 이 경로를 다시 지나는 쿼리가 아직 의미 있는 간선에 시각을
        // 새로 찍어 주기 때문이다.
        .map((edge) => ({ ...edge, lastUsedAt: edge.lastUsedAt ?? EPOCH })),
    );
    return fresh;
  }

  private disable(reason: string): void {
    this.enabled = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    console.error(`[catalog] disabled: ${reason}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private invalidateNameIndex(): void {
    this.nameIndex = null;
  }

  private ensureNameIndex(): Map<
    string,
    { schema: string; tables: Map<string, string> }
  > {
    if (this.nameIndex) return this.nameIndex;
    const index = new Map<
      string,
      { schema: string; tables: Map<string, string> }
    >();
    for (const [schemaName, schema] of Object.entries(this.data.schemas)) {
      const tables = new Map<string, string>();
      for (const tableName of Object.keys(schema.tables)) {
        tables.set(normalizeName(tableName), tableName);
      }
      index.set(normalizeName(schemaName), { schema: schemaName, tables });
    }
    this.nameIndex = index;
    return index;
  }

  /**
   * 카탈로그 전체 복사본. 비싸다는 것을 알고 쓴다. 모든 테이블을 한꺼번에 필요로 하는
   * 곳은 `map`, `search`, 그리고 문서 관련 동작뿐이다. 쿼리 경로에 있는 코드는 아래의
   * 좁은 읽기 함수들을 쓴다. 그 함수들이 존재하는 이유가 이것이다. 예전에는 테이블
   * 이름을 해석할 때마다 참조 하나당 카탈로그 전체를 복제했다.
   */
  snapshot(): CatalogFile {
    return structuredClone(this.data);
  }

  /** 문서 축만 복사한다. 응답 경로에서 써도 될 만큼 가볍다. */
  docsView(): CatalogDocs {
    return structuredClone(this.data.docs);
  }

  /**
   * 대소문자가 다를 수 있는 참조에 대한 정규 표기. 일치하는 것을 모두 돌려주므로,
   * 한정되지 않아 모호한 이름은 호출자에게도 모호한 채로 남는다.
   */
  lookup(
    schemaHint: string | null,
    table: string,
  ): Array<{ schema: string; table: string }> {
    const index = this.ensureNameIndex();
    const wanted = normalizeName(table);
    const scopes = schemaHint
      ? [index.get(normalizeName(schemaHint))]
      : [...index.values()];
    const matches: Array<{ schema: string; table: string }> = [];
    for (const scope of scopes) {
      if (!scope) continue;
      const canonical = scope.tables.get(wanted);
      if (canonical) matches.push({ schema: scope.schema, table: canonical });
    }
    return matches;
  }

  /** 스키마가 선언되어 있는지, 그리고 그 인벤토리를 마지막으로 스캔한 시각. */
  schemaState(schema: string): { scannedAt: string | null } | null {
    const entry = this.data.schemas[schema];
    return entry ? { scannedAt: entry.scannedAt } : null;
  }

  /** 테이블 하나에 대한 단순 값들. 카탈로그를 통째로 복제하지 않고 복사한다. */
  tableMeta(schema: string, table: string): CatalogTableMeta | null {
    const entry = this.data.schemas[schema]?.tables[table];
    if (!entry) return null;
    return {
      detailScannedAt: entry.detailScannedAt,
      detailStale: entry.detailStale === true,
      docReviewed: Object.prototype.hasOwnProperty.call(entry.curated, "doc"),
    };
  }

  /**
   * 테이블 하나의 인덱스 구성. 카탈로그를 통째로 복제하지 않고 복사한다. `tableMeta`가
   * 있는 이유와 같다. 타임아웃 진단은 오류 경로에서 도는데, 그 경로는 전체 스냅샷
   * 비용을 치를 수 없고 필요한 필드도 몇 개뿐이다.
   */
  tableIndexes(schema: string, table: string): CatalogIndexFacts | null {
    const entry = this.data.schemas[schema]?.tables[table];
    if (!entry) return null;
    return {
      schema,
      table,
      indexes: entry.indexes.map((index) => ({
        ...index,
        columns: [...index.columns],
      })),
      pk: [...entry.pk],
      rowsEstimate: entry.rowsEstimate,
      detailScannedAt: entry.detailScannedAt,
      detailStale: entry.detailStale === true,
    };
  }

  /** 테이블 하나를 복제해서 준다. 전체 스냅샷의 일부 비용만 든다. */
  readTable(schema: string, table: string): CatalogTable | null {
    const entry = this.data.schemas[schema]?.tables[table];
    return entry ? structuredClone(entry) : null;
  }

  /**
   * 테이블 중 하나라도 성공적으로 읽힌 적이 있는지. 도구 설명의 hot-table 목록이
   * 비어 있지 않게 되는 순간이 바로 여기다.
   */
  hasSuccessfulUse(): boolean {
    for (const schema of Object.values(this.data.schemas)) {
      for (const table of Object.values(schema.tables)) {
        if (table.usage.successCount > 0) return true;
      }
    }
    return false;
  }

  /** 테이블 하나에 맞닿은, 실제로 관측된 동등 조인. 많이 쓰인 순서. */
  readJoins(schema: string, table: string): CatalogJoin[] {
    const prefix = `${schema}.${table}.`.toLowerCase();
    return this.data.joins
      .filter(
        (edge) =>
          edge.a.toLowerCase().startsWith(prefix) ||
          edge.b.toLowerCase().startsWith(prefix),
      )
      .sort((a, b) => b.count - a.count || a.a.localeCompare(b.a))
      .slice(0, 20)
      .map((edge) => ({ ...edge }));
  }

  update(mutator: (catalog: CatalogFile) => void): void {
    if (!this.enabled) return;
    mutator(this.data);
    this.invalidateNameIndex();
    this.revision += 1;
    this.scheduleFlush();
  }

  scheduleFlush(): void {
    if (!this.enabled || this.closing || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref();
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    if (this.flushPromise) return this.flushPromise;
    if (this.revision === this.flushedRevision) return;
    this.flushPromise = this.writeAtomically().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async writeAtomically(): Promise<void> {
    let tempPath: string | null = null;
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      releaseLock = await acquireCatalogLock(
        this.options.filePath,
        this.closing ? LOCK_CLOSE_WAIT_MS : LOCK_WAIT_MS,
      );
      tempPath = `${this.options.filePath}.${process.pid}.${Date.now()}.tmp`;
      const writingRevision = this.revision;
      // `sanitizeLoaded`는 정규화도 한다. 예전 빌드의 writer가 빠뜨렸을 키를 채워
      // 넣는 것이 바로 이 함수다.
      let toWrite = this.sanitizeLoaded(structuredClone(this.data));
      // 락이 writer들을 한 줄로 세운다. 다른 프로세스가 쓰지 않았음을 mtime 해상도로
      // 증명하려 들지 말고, 언제나 최신 파일을 병합한다.
      const external = this.readExternal();
      if (
        external &&
        external.version === CATALOG_VERSION &&
        external.profile === this.options.profile &&
        external.fingerprint === this.options.fingerprint
      ) {
        toWrite = mergeCatalog(
          this.sanitizeLoaded(external),
          toWrite,
          this.baseData,
        );
        this.data = toWrite;
        this.invalidateNameIndex();
      }
      // 첫 await 전에 페이로드를 직렬화하고 병합 기준점을 기록한다. 지금 `this.data`는
      // `toWrite`와 같은 객체를 가리키므로, 쓰기가 진행되는 동안에도 `update()`가
      // 카운터를 올릴 수 있다. 그 증가분은 파일에 들어가 있지 않다. 이를 기준점으로
      // 기록해 두면 다음 3방향 병합이 증가분을 자기 자신에서 빼서 없애 버린다.
      const payload = `${JSON.stringify(toWrite, null, 2)}\n`;
      const persisted = structuredClone(toWrite);
      await fs.promises.writeFile(tempPath, payload, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(tempPath, this.options.filePath);
      await fs.promises.chmod(this.options.filePath, 0o600);
      this.baseData = persisted;
      this.flushedRevision = writingRevision;
      if (this.revision !== this.flushedRevision) this.scheduleFlush();
    } catch (error) {
      if (tempPath) {
        try {
          await fs.promises.unlink(tempPath);
        } catch {
          // 쓰기가 실패했다면 임시 파일이 아예 만들어지지 않았을 때가 많다.
        }
      }
      if (error instanceof CatalogLockTimeoutError) {
        // 락 경쟁에서 밀렸다고 남은 세션 내내 카탈로그 수집을 멈출 이유는 없다. 쓰인
        // 것은 없고, 대기 중인 리비전도 메모리에 그대로 있으며, `close()`가 스스로
        // 횟수를 제한한 재시도를 돌린다.
        console.error(`[catalog] ${error.message}; will retry`);
        this.scheduleFlush();
        return;
      }
      this.disable(
        `cannot write ${this.options.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (releaseLock) {
        try {
          await releaseLock();
        } catch (error) {
          this.disable(
            `cannot release catalog lock: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  /**
   * 다른 writer가 남긴 내용을 그대로 읽는다. 잘려 있거나 사람이 손댄 파일 때문에
   * 카탈로그를 꺼서는 안 된다. 뒤이어 일어나는 원자적 rename이 그 파일을 우리의
   * 올바른 내용으로 대체한다.
   */
  private readExternal(): CatalogFile | null {
    if (!fs.existsSync(this.options.filePath)) return null;
    try {
      return JSON.parse(
        fs.readFileSync(this.options.filePath, "utf8"),
      ) as CatalogFile;
    } catch (error) {
      console.error(
        `[catalog] ignoring unreadable ${this.options.filePath}; it will be replaced: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // 횟수를 제한한다. 락 타임아웃이 나면 리비전이 flush되지 않은 채 남는데, 제한이
    // 없으면 호출자가 아직 `stopTunnel()`까지 가야 하는 동안 여기서 영영 돈다.
    // `closing`은 시도마다의 락 대기 시간도 줄여 준다.
    for (let attempt = 0; attempt < CLOSE_FLUSH_ATTEMPTS; attempt += 1) {
      if (!this.enabled || this.revision === this.flushedRevision) return;
      if (this.flushPromise) await this.flushPromise;
      else await this.flush();
    }
    if (this.enabled && this.revision !== this.flushedRevision) {
      console.error(
        `[catalog] gave up persisting the last updates to ${this.options.filePath} after ${CLOSE_FLUSH_ATTEMPTS} attempts`,
      );
    }
  }
}
