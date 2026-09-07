import * as fs from "fs";
import * as path from "path";
import type {
  CatalogCurated,
  CatalogDocs,
  CatalogFile,
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
// Shutdown cannot afford the full wait. The client that closed our stdin is
// already gone, and blocking here only risks the process being killed before
// the SSH tunnel is torn down.
const LOCK_CLOSE_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const CLOSE_FLUSH_ATTEMPTS = 2;

/**
 * Raised when another writer held the lock for the whole wait. Recoverable on
 * its own: nothing is corrupt and the unflushed revision is still in memory,
 * so the caller retries instead of disabling the catalog.
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
          // A new owner can be between open and write. Only age can make an
          // unreadable lock stale, so another writer never removes it early.
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
          // Re-read before deletion so a recently acquired lock is not removed
          // after replacing the stale one that we inspected above.
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
  // A lower local value is an intentional reset from `forget`, not a lost
  // increment. Preserve only increments another process made after our base.
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
    // Two writers each below the cap can still merge to above it.
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
  /** Case-insensitive name lookup, rebuilt lazily after every mutation. */
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
    const parsed = JSON.parse(
      fs.readFileSync(this.options.filePath, "utf8"),
    ) as Partial<CatalogFile>;
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
    // Rewriting also removes PII columns left by a cache that was created
    // before redaction was enabled for this profile.
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
          columns: (raw.columns ?? []).filter(
            (column) => !this.options.isPIIColumn(column.name),
          ),
          pk: (raw.pk ?? []).filter(
            (column) => !this.options.isPIIColumn(column),
          ),
          indexes: (raw.indexes ?? [])
            .map((index) => ({
              ...index,
              columns: index.columns.filter(
                (column) => !this.options.isPIIColumn(column),
              ),
            }))
            .filter((index) => index.columns.length > 0),
          fks: (raw.fks ?? []).filter(
            (fk) =>
              !this.options.isPIIColumn(fk.column) &&
              !this.options.isPIIColumn(fk.referencedColumn),
          ),
          usage: {
            count: raw.usage?.count ?? 0,
            successCount: raw.usage?.successCount ?? raw.usage?.count ?? 0,
            failureCount: raw.usage?.failureCount ?? 0,
            lastUsedAt: raw.usage?.lastUsedAt ?? null,
            columns: Object.fromEntries(
              Object.entries(raw.usage?.columns ?? {}).filter(
                ([column]) => !this.options.isPIIColumn(column),
              ),
            ),
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
        .filter((edge) => {
          const aColumn = edge.a.slice(edge.a.lastIndexOf(".") + 1);
          const bColumn = edge.b.slice(edge.b.lastIndexOf(".") + 1);
          return (
            !this.options.isPIIColumn(aColumn) &&
            !this.options.isPIIColumn(bColumn)
          );
        })
        // A cache written before edges were stamped evicts first. It carries no
        // recency to compare, and the next query that walks the path re-stamps
        // whichever edges still matter.
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
   * Full copy of the catalog. Deliberately expensive: only `map`, `search` and
   * the document actions need every table at once. Anything on the query path
   * uses the targeted readers below, which is why they exist — resolving a
   * table name used to clone the entire catalog once per reference.
   */
  snapshot(): CatalogFile {
    return structuredClone(this.data);
  }

  /** Copy of the document axis alone. Cheap enough for the response path. */
  docsView(): CatalogDocs {
    return structuredClone(this.data.docs);
  }

  /**
   * Canonical spellings for a possibly differently-cased reference. Returns
   * every match so an ambiguous unqualified name stays ambiguous to the caller.
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

  /** Whether a schema is declared, and when its inventory was last scanned. */
  schemaState(schema: string): { scannedAt: string | null } | null {
    const entry = this.data.schemas[schema];
    return entry ? { scannedAt: entry.scannedAt } : null;
  }

  /** Scalar facts about one table, copied without cloning the catalog. */
  tableMeta(schema: string, table: string): CatalogTableMeta | null {
    const entry = this.data.schemas[schema]?.tables[table];
    if (!entry) return null;
    return {
      detailScannedAt: entry.detailScannedAt,
      detailStale: entry.detailStale === true,
      docReviewed: Object.prototype.hasOwnProperty.call(entry.curated, "doc"),
    };
  }

  /** One table, cloned. Costs a fraction of a full snapshot. */
  readTable(schema: string, table: string): CatalogTable | null {
    const entry = this.data.schemas[schema]?.tables[table];
    return entry ? structuredClone(entry) : null;
  }

  /**
   * Whether any table has been read successfully at least once. This is the
   * moment the hot-table list in the tool description stops being empty.
   */
  hasSuccessfulUse(): boolean {
    for (const schema of Object.values(this.data.schemas)) {
      for (const table of Object.values(schema.tables)) {
        if (table.usage.successCount > 0) return true;
      }
    }
    return false;
  }

  /** Observed equality joins touching one table, hottest first. */
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
      // Keep persistence as a second PII boundary. Collectors filter on input,
      // but future catalog writers must not be able to bypass that policy.
      let toWrite = this.sanitizeLoaded(structuredClone(this.data));
      // The lock serializes writers. Always merge the latest file instead of
      // relying on mtime resolution to prove that no other process wrote it.
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
      // Serialize the payload and record the merge ancestor before the first
      // await. `this.data` now aliases `toWrite`, so `update()` can still
      // increment counters while the write is in flight — and those increments
      // are not in the file. Recording them as the ancestor would make the next
      // three-way merge subtract them from themselves and drop them.
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
          // A failed write often means the temporary file was never created.
        }
      }
      if (error instanceof CatalogLockTimeoutError) {
        // Losing a race for the lock is not a reason to stop cataloguing for
        // the rest of the session. Nothing was written, the pending revision is
        // still in memory, and `close()` drives its own bounded retries.
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
   * Read whatever another writer left behind. A truncated or hand-edited file
   * must not disable the catalog: the atomic rename that follows replaces it
   * with our own valid content.
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
    // Bounded, because a lock timeout leaves the revision unflushed and would
    // otherwise spin here forever while the caller still has to reach
    // `stopTunnel()`. `closing` also shortens the lock wait per attempt.
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
