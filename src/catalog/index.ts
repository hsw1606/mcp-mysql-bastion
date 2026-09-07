import { createHash } from "crypto";
import * as os from "os";
import * as path from "path";
import type { TableRow } from "../types/index.js";
import { CatalogCollector } from "./collect.js";
import { CatalogDocuments } from "./docs.js";
import {
  renderDescribe,
  renderMap,
  renderToolDescriptionSuffix,
  searchCatalog,
} from "./render.js";
import { CatalogStore } from "./store.js";
import type {
  CatalogOptions,
  CatalogForgetScope,
  PreparedCatalogQuery,
  TableReference,
} from "./types.js";
import { emptyUsage, normalizeName, pruneJoins } from "./types.js";
import { prepareCatalogQuery, resultColumnNames } from "./usage.js";

const UNKNOWN_REFERENCE_REFRESH_COOLDOWN_MS = 60_000;
// One entry per distinct table name we could not resolve. Bounded so a session
// that keeps naming tables which do not exist cannot grow this without limit.
const UNKNOWN_REFERENCE_MEMORY_LIMIT = 256;
// Background work is deliberately started after the response is sent, so
// shutdown drains it. The deadline is what keeps a wedged git call or query
// from holding the shutdown path open before the tunnel is torn down.
const CLOSE_DRAIN_DEADLINE_MS = 3_000;
const NOTE_MAX_LENGTH = 1_000;
const ALIAS_MAX_LENGTH = 200;
// Curated text is the one thing here that no automatic pass may overwrite, so
// the limit refuses the write instead of evicting an older entry the way the
// derived axes do. A table that has hit either bound wants `forget`, not a
// silently dropped memo.
const NOTE_COUNT_LIMIT = 50;
const ALIAS_COUNT_LIMIT = 20;

/**
 * A referenced timer, plus the means to cancel it. Referenced on purpose: an
 * unreferenced deadline never fires once the hung task is the only thing left
 * on the loop, which is exactly the case the deadline exists for. Cancelling
 * it after the race keeps it from outliving its usefulness.
 */
function deadlineTimer(ms: number): { expired: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

export interface CatalogIdentity {
  profile: string;
  /** Stable identity of the database endpoint, before any local SSH forwarding. */
  target: string;
  user: string;
  customPath?: string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * The file name and the fingerprint have to be built from the same inputs. The
 * fingerprint decides whether a loaded catalog may be reused, and a mismatch
 * skips the merge and overwrites — so any input the fingerprint counts but the
 * name does not gives two servers one file that each discards on start and
 * clobbers on every flush. The user belongs in both because two accounts on one
 * host hold different grants, and therefore see different tables.
 */
export function catalogIdentity(identity: CatalogIdentity): {
  filePath: string;
  fingerprint: string;
} {
  const profile = identity.profile || "default";
  const safeProfile = profile.replace(/[^A-Za-z0-9_.-]/g, "_");
  // NUL separates the parts because it cannot appear in a host name or a
  // MySQL user, so no two distinct endpoints can collapse onto one identity.
  const endpointHash = shortHash(`${identity.target}\u0000${identity.user}`);
  const directory =
    identity.customPath ??
    path.join(os.homedir(), ".cache", "mcp-mysql-bastion", "catalog");
  return {
    filePath: path.join(directory, `${safeProfile}-${endpointHash}.json`),
    fingerprint: endpointHash,
  };
}

function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

/**
 * Resolving a name and mutating the entry are separate steps, and a flush merge
 * or a background inventory scan in between can drop a table the database no
 * longer has. Saying so beats the `undefined` property read that preceded this.
 */
function tableVanished(qualified: string): string {
  return `${qualified} is no longer in the catalog; it was dropped while the request was in flight. Run mysql_catalog {action:"map"} to see what remains.`;
}

export class SchemaCatalog {
  private readonly store: CatalogStore;
  private readonly collector: CatalogCollector;
  private readonly documents: CatalogDocuments;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly unknownReferenceRefreshes = new Map<string, number>();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private toolDescriptionListener: (() => void | Promise<void>) | null = null;
  private toolDescriptionAnnounced = false;

  constructor(private readonly options: CatalogOptions) {
    this.store = new CatalogStore(options);
    this.collector = new CatalogCollector(this.store, {
      schemas: options.appSchemas.map((entry) => entry.schema),
      ttlHours: options.ttlHours,
      isPIIColumn: options.isPIIColumn,
    });
    this.documents = new CatalogDocuments(this.store, {
      repo: options.docsRepo,
      ref: options.docsRef,
      appSchemas: options.appSchemas,
    });
  }

  isEnabled(): boolean {
    return this.store.isEnabled();
  }

  startInventory(): void {
    if (!this.isEnabled() || this.closing) return;
    // Deliberately not forced. MCP clients start a fresh server per session,
    // so forcing here would rescan on every session and make
    // MYSQL_CATALOG_TTL_HOURS meaningless for the inventory. An empty or
    // expired inventory still refreshes: `inventoryNeedsRefresh` treats a
    // missing `scannedAt` as expired.
    this.trackBackgroundTask(
      this.collector.collectInventory(false).catch((error) => {
        console.error(
          `[catalog] inventory scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    );
  }

  toolDescriptionSuffix(): string {
    if (!this.isEnabled()) return "";
    return renderToolDescriptionSuffix(this.store.snapshot());
  }

  /**
   * Called once, the first time the hot-table list stops being empty. That list
   * holds only tables a query has actually read, so the inventory scan is not
   * the moment the tool description changes — the first successful query is.
   * One call per process, which is what caps the notification at one a session.
   */
  onToolDescriptionFilled(listener: () => void | Promise<void>): void {
    this.toolDescriptionListener = listener;
  }

  private async announceToolDescription(): Promise<void> {
    if (this.toolDescriptionAnnounced || !this.toolDescriptionListener) return;
    if (!this.store.hasSuccessfulUse()) return;
    this.toolDescriptionAnnounced = true;
    await this.toolDescriptionListener();
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    );
  }

  /**
   * Canonical schema and table names for a reference written in any casing.
   * Resolves through the store's name index rather than a snapshot: this runs
   * several times per query, and cloning the catalog each time put tens of
   * milliseconds of blocked event loop on every response.
   */
  private resolveTable(input: string): { schema: string; table: string } | null {
    const cleaned = input.replace(/`/g, "").trim();
    const dot = cleaned.indexOf(".");
    const requestedSchema = dot === -1 ? null : cleaned.slice(0, dot);
    const requestedTable = dot === -1 ? cleaned : cleaned.slice(dot + 1);
    const matches = this.store.lookup(requestedSchema, requestedTable);
    if (matches.length === 1) return matches[0];
    if (!requestedSchema && this.options.defaultSchema) {
      return (
        matches.find((match) =>
          sameName(match.schema, this.options.defaultSchema as string),
        ) ?? null
      );
    }
    return null;
  }

  /** Whether a model or user already recorded a document decision. */
  private documentReviewed(schema: string, table: string): boolean {
    return this.store.tableMeta(schema, table)?.docReviewed === true;
  }

  private catalogKeyForReference(reference: TableReference): string | null {
    const requestedSchema = reference.schema ?? this.options.defaultSchema;
    if (!requestedSchema) return null;
    const declared = this.options.appSchemas.find((entry) =>
      sameName(entry.schema, requestedSchema),
    );
    return declared
      ? `${declared.schema}.${reference.table}`.toLowerCase()
      : null;
  }

  private resolveReferences(
    references: TableReference[],
  ): Array<{ schema: string; table: string }> {
    return references
      .map((reference) =>
        this.resolveTable(
          reference.schema
            ? `${reference.schema}.${reference.table}`
            : reference.table,
        ),
      )
      .filter((value): value is NonNullable<typeof value> => value !== null);
  }

  private async ensureKnownTable(
    input: string,
  ): Promise<{ schema: string; table: string }> {
    let resolved = this.resolveTable(input);
    if (!resolved) {
      await this.collector.collectInventory(false);
      resolved = this.resolveTable(input);
    }
    if (!resolved) {
      throw new Error(
        `Unknown or ambiguous table "${input}". Use a declared schema.table name.`,
      );
    }
    return resolved;
  }

  async map(): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    if (this.collector.inventoryNeedsRefresh()) {
      await this.collector.collectInventory(false);
    }
    let documentWarning: string | null = null;
    if (this.documents.isConfigured()) {
      try {
        await this.documents.ensureAwake();
      } catch (error) {
        // A broken document repository must not hide the database catalog.
        documentWarning = error instanceof Error ? error.message : String(error);
      }
    }
    return renderMap(
      this.store.snapshot(),
      documentWarning ?? this.documents.staleWarning(),
    );
  }

  async search(query: string, requestedLimit?: number): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    // Same cold-start guard as `map`. Without it the first search of a session
    // reads an empty snapshot and returns no hits, which reads to the model as
    // "no such table" rather than "not scanned yet".
    if (this.collector.inventoryNeedsRefresh()) {
      await this.collector.collectInventory(false);
    }
    const limit = Math.min(100, Math.max(1, requestedLimit ?? 20));
    return JSON.stringify(
      searchCatalog(
        this.store.snapshot(),
        query,
        limit,
        this.options.isPIIColumn,
      ),
      null,
      2,
    );
  }

  async describe(input: string): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    const resolved = await this.ensureKnownTable(input);
    await this.collector.collectTableDetail(resolved.schema, resolved.table);
    let documentError: string | null = null;
    if (this.documents.isConfigured()) {
      try {
        await this.documents.ensureAwake();
      } catch (error) {
        documentError = error instanceof Error ? error.message : String(error);
      }
    }
    // Read the table once, after both refreshes. Waking the document axis can
    // drop a link whose file no longer exists at the ref, so an earlier read
    // would render a document that has just been unlinked.
    const entry = this.store.readTable(resolved.schema, resolved.table);
    if (!entry) throw new Error(`Table disappeared during refresh: ${input}`);
    return renderDescribe(
      `${resolved.schema}.${resolved.table}`,
      entry,
      this.options.isPIIColumn,
      {
        configured: this.documents.isConfigured(),
        available: this.documents.isAvailable(),
        ref: this.options.docsRef,
        command: entry.curated.doc
          ? this.documents.documentCommand(entry.curated.doc.path)
          : null,
        warning: documentError ?? this.documents.staleWarning(),
        schema: resolved.schema,
      },
      this.store.readJoins(resolved.schema, resolved.table),
    );
  }

  /**
   * Force re-collection of what the server derives on its own.
   *
   * The automatic invalidation is error-driven: a query that names a column or
   * table the database does not have marks that entry stale. That only detects
   * the catalog claiming too much. It is blind the other way — a migration that
   * *adds* a column, index or foreign key produces no error, because a model
   * never names something it does not know exists, so nothing marks the entry
   * stale and the catalog under-reports for up to a full TTL. That case is
   * worse than a failed query: SQL written without a freshly added `deletedAt`
   * succeeds and silently returns soft-deleted rows. This is the manual way out
   * of that window, and it costs one query.
   */
  async refresh(target?: string): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    const requested = (target ?? "").replace(/`/g, "").trim();
    const at = new Date().toISOString();

    if (!requested) {
      await this.collector.collectInventory(true);
      return JSON.stringify(
        {
          refreshed: "inventory",
          ...this.inventoryReport(),
          ...(this.documents.isConfigured()
            ? { documents: await this.refreshDocuments() }
            : {}),
          at,
        },
        null,
        2,
      );
    }

    if (normalizeName(requested) === "docs") {
      return JSON.stringify(
        {
          refreshed: "documents",
          documents: await this.refreshDocuments(),
          hint: 'A table actually named "docs" must be written as schema.docs.',
          at,
        },
        null,
        2,
      );
    }

    // A declared schema name wins over a table of the same name, because this
    // environment really does have a `call` schema and tables named after
    // schemas are possible. Qualifying with a dot always means the table.
    const declared = requested.includes(".")
      ? undefined
      : this.options.appSchemas.find((entry) => sameName(entry.schema, requested));
    if (declared) {
      // One query covers every declared schema, so the whole inventory is
      // rescanned regardless of which schema was named. Report it honestly.
      await this.collector.collectInventory(true);
      return JSON.stringify(
        {
          refreshed: "inventory",
          requestedSchema: declared.schema,
          note: "인벤토리는 선언된 모든 스키마를 쿼리 한 번으로 함께 갱신합니다.",
          ...this.inventoryReport(),
          at,
        },
        null,
        2,
      );
    }

    let resolved = this.resolveTable(requested);
    if (!resolved && requested.includes(".")) {
      // A table a migration just created is not in the inventory yet, and
      // asking about it is exactly why someone calls refresh. A qualified name
      // is an explicit claim that this table exists, so spend the one query to
      // check. A bare unknown word is far likelier a typo and gets no query.
      await this.collector.collectInventory(true);
      resolved = this.resolveTable(requested);
    }
    if (resolved) {
      await this.collector.collectTableDetail(resolved.schema, resolved.table, true);
      const entry = this.store.readTable(resolved.schema, resolved.table);
      return JSON.stringify(
        {
          refreshed: "table",
          table: `${resolved.schema}.${resolved.table}`,
          detailScannedAt: entry?.detailScannedAt ?? null,
          columns: entry?.columns.length ?? 0,
          indexes: entry?.indexes.length ?? 0,
          foreignKeys: entry?.fks.length ?? 0,
          at,
        },
        null,
        2,
      );
    }

    throw new Error(
      `Unknown refresh target "${requested}". Use schema.table for one table's ` +
        'columns, a declared schema name for the table inventory, "docs" for the ' +
        "document axis, or omit target for both.",
    );
  }

  private inventoryReport(): {
    schemas: number;
    tables: number;
    scannedAt: string | null;
  } {
    const catalog = this.store.snapshot();
    const schemas = Object.values(catalog.schemas);
    return {
      schemas: schemas.length,
      tables: schemas.reduce(
        (total, schema) => total + Object.keys(schema.tables).length,
        0,
      ),
      scannedAt: schemas[0]?.scannedAt ?? null,
    };
  }

  private async refreshDocuments(): Promise<{
    refreshed: boolean;
    ref: string | null;
    refCommit?: string | null;
    paths?: number;
    error?: string;
  }> {
    if (!this.documents.isConfigured()) {
      return {
        refreshed: false,
        ref: null,
        error:
          "The document axis is disabled because MYSQL_DOCS_REPO or MYSQL_CODE_BRANCH is not configured.",
      };
    }
    this.documents.resetWake();
    try {
      await this.documents.ensureAwake();
      const docs = this.store.docsView();
      return {
        refreshed: true,
        ref: docs.ref,
        refCommit: docs.refCommit,
        paths: docs.paths.length,
      };
    } catch (error) {
      // A broken document repository must not fail the database refresh.
      return {
        refreshed: false,
        ref: this.options.docsRef,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async docsList(schemaName: string): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    return this.documents.list(schemaName);
  }

  async docsRead(documentPath: string): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    return this.documents.read(documentPath);
  }

  async link(
    links: Array<{ table: string; doc: string }>,
  ): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    if (links.length === 0) throw new Error('mysql_catalog link requires a non-empty "links" array.');
    const resolvedLinks = [];
    for (const link of links) {
      const table = await this.ensureKnownTable(link.table);
      resolvedLinks.push({
        schema: table.schema,
        table: table.table,
        doc: link.doc,
      });
    }
    return this.documents.link(resolvedLinks);
  }

  async unlink(input: string): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    const resolved = await this.ensureKnownTable(input);
    return this.documents.unlink(resolved.schema, resolved.table);
  }

  async note(
    input: string,
    value: { text?: string; alias?: string },
  ): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    const hasText =
      typeof value.text === "string" && value.text.trim().length > 0;
    const hasAlias =
      typeof value.alias === "string" && value.alias.trim().length > 0;
    if (hasText === hasAlias) {
      throw new Error('mysql_catalog note requires exactly one of "text" or "alias".');
    }
    const resolved = await this.ensureKnownTable(input);
    const kind = hasText ? "note" : "alias";
    const content = (hasText ? value.text : value.alias)?.trim() as string;
    const limit = hasText ? NOTE_MAX_LENGTH : ALIAS_MAX_LENGTH;
    if (content.length > limit) {
      throw new Error(`${kind} exceeds the ${limit}-character limit.`);
    }
    const qualified = `${resolved.schema}.${resolved.table}`;
    let full = false;
    let missing = false;
    this.store.update((catalog) => {
      const curated =
        catalog.schemas[resolved.schema]?.tables[resolved.table]?.curated;
      if (!curated) {
        missing = true;
        return;
      }
      if (hasText) {
        if (curated.notes.includes(content)) return;
        if (curated.notes.length >= NOTE_COUNT_LIMIT) {
          full = true;
          return;
        }
        curated.notes.push(content);
      } else {
        if (
          curated.aliases.some(
            (alias) => normalizeName(alias) === normalizeName(content),
          )
        ) {
          return;
        }
        if (curated.aliases.length >= ALIAS_COUNT_LIMIT) {
          full = true;
          return;
        }
        curated.aliases.push(content);
      }
    });
    if (missing) throw new Error(tableVanished(qualified));
    if (full) {
      throw new Error(
        `${qualified} already holds the maximum of ${
          hasText ? NOTE_COUNT_LIMIT : ALIAS_COUNT_LIMIT
        } ${kind}s. Clear them with mysql_catalog {action:"forget", target:"${qualified}", scope:"${kind}s"} first.`,
      );
    }
    const table = this.store.readTable(resolved.schema, resolved.table);
    return JSON.stringify(
      {
        target: qualified,
        added: { [kind]: content },
        notes: table?.curated.notes ?? [],
        aliases: table?.curated.aliases ?? [],
      },
      null,
      2,
    );
  }

  async forget(input: string, scope: CatalogForgetScope): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    const resolved = await this.ensureKnownTable(input);
    const qualified = `${resolved.schema}.${resolved.table}`;
    let removed = 0;
    let missing = false;
    this.store.update((catalog) => {
      const table = catalog.schemas[resolved.schema]?.tables[resolved.table];
      if (!table) {
        missing = true;
        return;
      }
      if (scope === "notes") {
        removed = table.curated.notes.length;
        table.curated.notes = [];
      } else if (scope === "aliases") {
        removed = table.curated.aliases.length;
        table.curated.aliases = [];
      } else if (scope === "usage") {
        removed = table.usage.count;
        table.usage = emptyUsage();
      } else if (scope === "joins") {
        const prefix = `${qualified}.`.toLowerCase();
        const before = catalog.joins.length;
        catalog.joins = catalog.joins.filter(
          (edge) =>
            !edge.a.toLowerCase().startsWith(prefix) &&
            !edge.b.toLowerCase().startsWith(prefix),
        );
        removed = before - catalog.joins.length;
      } else {
        removed =
          table.columns.length + table.indexes.length + table.fks.length;
        table.columns = [];
        table.pk = [];
        table.indexes = [];
        table.fks = [];
        table.detailScannedAt = null;
        table.detailStale = true;
      }
    });
    if (missing) throw new Error(tableVanished(qualified));
    return JSON.stringify(
      {
        target: qualified,
        forgotten: scope,
        removed,
        ...(scope === "metadata"
          ? { next: "The next describe or successful query refreshes table metadata." }
          : {}),
      },
      null,
      2,
    );
  }

  queryDocumentGuidance(prepared: PreparedCatalogQuery): string | null {
    if (!this.isEnabled() || !this.documents.isConfigured()) return null;
    const notices: string[] = [];
    const documentError = this.documents.error();
    if (documentError) notices.push(`[카탈로그 경고] ${documentError}`);
    else {
      const stale = this.documents.staleWarning();
      if (stale) notices.push(stale);
    }
    if (!this.documents.isAvailable()) return notices.join("\n") || null;
    const unresolved = new Map<string, string>();
    for (const reference of prepared.references) {
      const resolved = this.resolveTable(
        reference.schema
          ? `${reference.schema}.${reference.table}`
          : reference.table,
      );
      if (resolved && !this.documentReviewed(resolved.schema, resolved.table)) {
        unresolved.set(`${resolved.schema}.${resolved.table}`, resolved.schema);
      }
    }
    notices.push(
      ...[...unresolved.entries()].map(
        ([table, schema]) =>
          `[카탈로그] ${table} 에 연결된 문서가 없습니다.\n` +
          `mysql_catalog {action:"docs_list", schema:"${schema}"} 로 후보를 보고\n` +
          'mysql_catalog {action:"link", links:[{table:"' +
          `${table}", doc:"..."}]} 로 연결하세요.`,
      ),
    );
    return notices.join("\n\n") || null;
  }

  async listTables(): Promise<TableRow[]> {
    if (!this.isEnabled()) return [];
    if (this.collector.inventoryNeedsRefresh()) {
      await this.collector.collectInventory(false);
    }
    return Object.entries(this.store.snapshot().schemas).flatMap(
      ([schemaName, schema]) =>
        Object.entries(schema.tables).map(([tableName, table]) => ({
          table_name: tableName,
          name: tableName,
          database: schemaName,
          description: table.comment,
          rowCount: table.rowsEstimate ?? undefined,
        })),
    );
  }

  prepareQuery(sql: string): PreparedCatalogQuery {
    if (!this.isEnabled()) return { references: [], joins: [] };
    return prepareCatalogQuery(sql);
  }

  afterQuery(
    prepared: PreparedCatalogQuery,
    result: { content?: Array<{ type: string; text: string }>; isError?: boolean },
    error?: unknown,
  ): void {
    if (
      !this.isEnabled() ||
      this.closing ||
      prepared.references.length === 0
    ) {
      return;
    }
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        const documentWake = this.referencesNeedDocuments(prepared.references)
          ? this.documents.ensureAwake().catch(() => {
              // CatalogDocuments logs and remembers the document-only failure.
            })
          : Promise.resolve();
        const queryUpdate = this.processQuery(prepared, result, error).catch(
          (cause) => {
            console.error(
              `[catalog] post-query update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          },
        );
        void Promise.all([documentWake, queryUpdate]).then(() => resolve());
      });
    });
    this.trackBackgroundTask(task);
  }

  private referencesNeedDocuments(references: TableReference[]): boolean {
    if (!this.documents.isAvailable()) return false;
    return references.some((reference) => {
      const resolved = this.resolveTable(
        reference.schema
          ? `${reference.schema}.${reference.table}`
          : reference.table,
      );
      return Boolean(
        resolved && !this.documentReviewed(resolved.schema, resolved.table),
      );
    });
  }

  private async processQuery(
    prepared: PreparedCatalogQuery,
    result: { content?: Array<{ type: string; text: string }>; isError?: boolean },
    error?: unknown,
  ): Promise<void> {
    const { references } = prepared;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const succeeded = !error && !result.isError;

    const inventoryWasStale =
      succeeded && this.collector.inventoryNeedsRefresh();
    if (inventoryWasStale) {
      await this.collector.collectInventory(false);
    }
    let resolved = this.resolveReferences(references);
    if (succeeded) {
      const resolvedKeys = new Set(
        resolved.map((value) => `${value.schema}.${value.table}`.toLowerCase()),
      );
      const unresolvedKeys = [
        ...new Set(
          references
            .map((reference) => this.catalogKeyForReference(reference))
            .filter(
              (key): key is string => key !== null && !resolvedKeys.has(key),
            ),
        ),
      ];
      const now = Date.now();
      const needsUnknownRefresh = unresolvedKeys.some(
        (key) =>
          now - (this.unknownReferenceRefreshes.get(key) ?? 0) >=
          UNKNOWN_REFERENCE_REFRESH_COOLDOWN_MS,
      );
      if (inventoryWasStale) {
        for (const key of unresolvedKeys) {
          this.rememberUnknownReference(key, now);
        }
      } else if (needsUnknownRefresh) {
        await this.collector.collectInventory(true);
        for (const key of unresolvedKeys) {
          this.rememberUnknownReference(key, now);
        }
        resolved = this.resolveReferences(references);
      }
    }
    const unique = new Map(
      resolved.map((value) => [`${value.schema}.${value.table}`, value]),
    );
    if (
      this.documents.isAvailable() &&
      [...unique.values()].some(
        (value) => !this.documentReviewed(value.schema, value.table),
      )
    ) {
      await this.documents.ensureAwake().catch(() => {
        // The database usage path remains healthy when the document axis fails.
      });
    }
    const columns = resultColumnNames(result.content?.[0]?.text ?? "").filter(
      (column) => !this.options.isPIIColumn(column),
    );
    const now = new Date().toISOString();
    this.store.update((catalog) => {
      for (const value of unique.values()) {
        const table = catalog.schemas[value.schema]?.tables[value.table];
        if (!table) continue;
        table.usage.count += 1;
        if (succeeded) table.usage.successCount += 1;
        else table.usage.failureCount += 1;
        table.usage.lastUsedAt = now;
        if (code === "ER_BAD_FIELD_ERROR" || code === "ER_NO_SUCH_TABLE") {
          table.detailStale = true;
          if (code === "ER_NO_SUCH_TABLE") {
            catalog.schemas[value.schema].scannedAt = null;
          }
        }
      }
      if (succeeded) {
        for (const join of prepared.joins) {
          if (
            this.options.isPIIColumn(join.a.column) ||
            this.options.isPIIColumn(join.b.column)
          ) {
            continue;
          }
          const left = this.resolveTable(
            join.a.schema ? `${join.a.schema}.${join.a.table}` : join.a.table,
          );
          const right = this.resolveTable(
            join.b.schema ? `${join.b.schema}.${join.b.table}` : join.b.table,
          );
          if (!left || !right) continue;
          const endpoints = [
            `${left.schema}.${left.table}.${join.a.column}`,
            `${right.schema}.${right.table}.${join.b.column}`,
          ].sort();
          const existing = catalog.joins.find(
            (edge) => edge.a === endpoints[0] && edge.b === endpoints[1],
          );
          if (existing) {
            existing.count += 1;
            existing.lastUsedAt = now;
          } else {
            catalog.joins.push({
              a: endpoints[0],
              b: endpoints[1],
              count: 1,
              lastUsedAt: now,
            });
          }
        }
        catalog.joins = pruneJoins(catalog.joins);
      }
    });
    if (!succeeded) {
      if (code === "ER_BAD_FIELD_ERROR") {
        await Promise.all(
          [...unique.values()].map((value) =>
            this.collector.collectTableDetail(value.schema, value.table, true),
          ),
        );
      } else if (code === "ER_NO_SUCH_TABLE") {
        await this.collector.collectInventory(true);
      }
      return;
    }
    await Promise.all(
      [...unique.values()].map((value) =>
        this.collector
          .collectTableDetail(value.schema, value.table)
          .catch((cause) => {
            console.error(
              `[catalog] detail scan failed for ${value.schema}.${value.table}: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }),
        ),
    );
    this.store.update((catalog) => {
      for (const column of columns) {
        // Membership is checked even when the query touched a single table.
        // These names come from the result keys, so a projection like
        // `COUNT(*) AS total` would otherwise persist `total` as a column of
        // that table and `describe` would report it from then on.
        const owners = [...unique.values()].filter((value) => {
          const table = catalog.schemas[value.schema]?.tables[value.table];
          return table?.columns.some((known) => sameName(known.name, column));
        });
        if (owners.length !== 1) continue;
        const owner = owners[0];
        const table = catalog.schemas[owner.schema]?.tables[owner.table];
        if (table) {
          table.usage.columns[column] = (table.usage.columns[column] ?? 0) + 1;
        }
      }
    });
    await this.announceToolDescription();
  }

  /**
   * Record that we have just refreshed the inventory for an unresolvable name,
   * evicting the oldest entries once the map reaches its bound. A Map iterates
   * in insertion order, so re-inserting the key keeps eviction chronological.
   */
  private rememberUnknownReference(key: string, at: number): void {
    this.unknownReferenceRefreshes.delete(key);
    this.unknownReferenceRefreshes.set(key, at);
    while (this.unknownReferenceRefreshes.size > UNKNOWN_REFERENCE_MEMORY_LIMIT) {
      const oldest = this.unknownReferenceRefreshes.keys().next();
      if (oldest.done) break;
      this.unknownReferenceRefreshes.delete(oldest.value);
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (async () => {
        // A stdio client commonly closes stdin immediately after receiving its
        // final tool result. Inventory, detail, and document work deliberately
        // runs after that result, so drain it before the last durable flush.
        //
        // The deadline is the point: our caller closes the pool and the SSH
        // tunnel after us, and a task that never settles would leak both.
        // Whatever is already recorded still gets persisted.
        const deadline = Date.now() + CLOSE_DRAIN_DEADLINE_MS;
        while (this.backgroundTasks.size > 0) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            console.error(
              `[catalog] ${this.backgroundTasks.size} background task(s) did not finish within ${CLOSE_DRAIN_DEADLINE_MS}ms; persisting what is already recorded`,
            );
            break;
          }
          const deadlineReached = deadlineTimer(remaining);
          try {
            await Promise.race([
              Promise.allSettled([...this.backgroundTasks]),
              deadlineReached.expired,
            ]);
          } finally {
            deadlineReached.cancel();
          }
        }
        await this.store.close();
      })();
    }
    await this.closePromise;
  }
}

export type {
  CatalogForgetScope,
  CatalogOptions,
  TableReference,
} from "./types.js";
