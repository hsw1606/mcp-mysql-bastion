import * as fs from "fs";
import * as path from "path";
import type {
  CatalogCurated,
  CatalogFile,
  CatalogOptions,
  CatalogSchema,
  CatalogTable,
} from "./types.js";
import { CATALOG_VERSION, emptyCatalog, emptyTable } from "./types.js";
import { fingerprintColumnNames } from "./usage.js";

const FLUSH_DELAY_MS = 2_000;

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
  for (const current of local) merged.add(current);
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
  return external + Math.max(0, local - base);
}

function mergeTable(
  external: CatalogTable,
  local: CatalogTable,
  base?: CatalogTable,
): CatalogTable {
  const newerDetail =
    timestamp(local.detailScannedAt) >= timestamp(external.detailScannedAt)
      ? local
      : external;
  return {
    ...newerDetail,
    usage: {
      count: mergedCounter(
        external.usage?.count ?? 0,
        local.usage?.count ?? 0,
        base?.usage?.count ?? 0,
      ),
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
      lastUsedAt:
        timestamp(local.usage?.lastUsedAt) >=
        timestamp(external.usage?.lastUsedAt)
          ? local.usage?.lastUsedAt ?? null
          : external.usage?.lastUsedAt ?? null,
      columns: Object.fromEntries(
        [...new Set([
          ...Object.keys(external.usage?.columns ?? {}),
          ...Object.keys(local.usage?.columns ?? {}),
        ])].map((column) => [
          column,
          mergedCounter(
            external.usage?.columns?.[column] ?? 0,
            local.usage?.columns?.[column] ?? 0,
            base?.usage?.columns?.[column] ?? 0,
          ),
        ]),
      ),
      fingerprints: Object.fromEntries(
        [...new Set([
          ...Object.keys(external.usage?.fingerprints ?? {}),
          ...Object.keys(local.usage?.fingerprints ?? {}),
        ])].map((fingerprint) => {
          const left = external.usage?.fingerprints?.[fingerprint];
          const right = local.usage?.fingerprints?.[fingerprint];
          const ancestor = base?.usage?.fingerprints?.[fingerprint];
          const newer =
            timestamp(right?.lastUsedAt) >= timestamp(left?.lastUsedAt)
              ? right
              : left;
          return [
            fingerprint,
            {
              count: mergedCounter(
                left?.count ?? 0,
                right?.count ?? 0,
                ancestor?.count ?? 0,
              ),
              successCount: mergedCounter(
                left?.successCount ?? 0,
                right?.successCount ?? 0,
                ancestor?.successCount ?? 0,
              ),
              failureCount: mergedCounter(
                left?.failureCount ?? 0,
                right?.failureCount ?? 0,
                ancestor?.failureCount ?? 0,
              ),
              lastUsedAt: newer?.lastUsedAt ?? new Date(0).toISOString(),
            },
          ];
        }),
      ),
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
  const joins = new Map<string, { a: string; b: string; count: number }>();
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
    joins.set(key, {
      a: edge.a,
      b: edge.b,
      count: mergedCounter(
        outside?.count ?? 0,
        inside?.count ?? 0,
        ancestor?.count ?? 0,
      ),
    });
  }
  return {
    ...local,
    docs: {
      ...external.docs,
      ...local.docs,
      paths: [
        ...new Set([...(external.docs.paths ?? []), ...(local.docs.paths ?? [])]),
      ],
      unlinked: [
        ...new Set([
          ...(external.docs.unlinked ?? []),
          ...(local.docs.unlinked ?? []),
        ]),
      ],
    },
    schemas,
    joins: [...joins.values()],
  };
}

export class CatalogStore {
  private enabled: boolean;
  private data: CatalogFile;
  private baseData: CatalogFile;
  private loadedMtimeMs: number | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private revision = 0;
  private flushedRevision = 0;

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
    this.baseData = structuredClone(this.data);
    this.loadedMtimeMs = fs.statSync(this.options.filePath).mtimeMs;
    // Rewriting also removes PII columns left by a cache that was created
    // before redaction was enabled for this profile.
    this.revision += 1;
    this.scheduleFlush();
    console.error(`[catalog] loaded ${this.options.filePath}`);
  }

  private sanitizeLoaded(loaded: CatalogFile): CatalogFile {
    const fresh = emptyCatalog(this.options);
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
            fingerprints: Object.fromEntries(
              Object.entries(raw.usage?.fingerprints ?? {}).filter(
                ([fingerprint]) => {
                  if (!this.options.piiRedactionEnabled) return true;
                  const columns = fingerprintColumnNames(fingerprint);
                  return (
                    columns !== null &&
                    !columns.some(this.options.isPIIColumn)
                  );
                },
              ),
            ),
          },
          curated: {
            notes: raw.curated?.notes ?? [],
            aliases: raw.curated?.aliases ?? [],
            ...(Object.prototype.hasOwnProperty.call(raw.curated ?? {}, "doc")
              ? { doc: raw.curated.doc }
              : {}),
          },
        };
        schema.tables[tableName] = table;
      }
    }
    fresh.docs = { ...fresh.docs, ...(loaded.docs ?? {}) };
    fresh.joins = (loaded.joins ?? []).filter((edge) => {
      const aColumn = edge.a.slice(edge.a.lastIndexOf(".") + 1);
      const bColumn = edge.b.slice(edge.b.lastIndexOf(".") + 1);
      return (
        !this.options.isPIIColumn(aColumn) &&
        !this.options.isPIIColumn(bColumn)
      );
    });
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

  snapshot(): CatalogFile {
    return structuredClone(this.data);
  }

  update(mutator: (catalog: CatalogFile) => void): void {
    if (!this.enabled) return;
    mutator(this.data);
    this.revision += 1;
    this.scheduleFlush();
  }

  scheduleFlush(): void {
    if (!this.enabled || this.flushTimer) return;
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
    const tempPath = `${this.options.filePath}.${process.pid}.${Date.now()}.tmp`;
    const writingRevision = this.revision;
    try {
      // Keep persistence as a second PII boundary. Collectors filter on input,
      // but future catalog writers must not be able to bypass that policy.
      let toWrite = this.sanitizeLoaded(structuredClone(this.data));
      if (fs.existsSync(this.options.filePath)) {
        const currentMtime = fs.statSync(this.options.filePath).mtimeMs;
        if (this.loadedMtimeMs === null || currentMtime !== this.loadedMtimeMs) {
          const external = JSON.parse(
            fs.readFileSync(this.options.filePath, "utf8"),
          ) as CatalogFile;
          if (
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
          }
        }
      }
      await fs.promises.writeFile(tempPath, `${JSON.stringify(toWrite, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(tempPath, this.options.filePath);
      await fs.promises.chmod(this.options.filePath, 0o600);
      this.loadedMtimeMs = (await fs.promises.stat(this.options.filePath)).mtimeMs;
      this.baseData = structuredClone(toWrite);
      this.flushedRevision = writingRevision;
      if (this.revision !== this.flushedRevision) this.scheduleFlush();
    } catch (error) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // A failed write often means the temporary file was never created.
      }
      this.disable(
        `cannot write ${this.options.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.enabled && this.revision !== this.flushedRevision) {
      if (this.flushPromise) await this.flushPromise;
      else await this.flush();
    }
  }
}
