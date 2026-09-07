import { createHash } from "crypto";
import * as os from "os";
import * as path from "path";
import type { TableRow } from "../types/index.js";
import { CatalogCollector } from "./collect.js";
import { renderDescribe, renderMap, searchCatalog } from "./render.js";
import { CatalogStore } from "./store.js";
import type {
  CatalogOptions,
  CatalogTable,
  PreparedCatalogQuery,
  TableReference,
} from "./types.js";
import { prepareCatalogQuery, resultColumnNames } from "./usage.js";

export interface CatalogIdentity {
  profile: string;
  host: string;
  user: string;
  customPath?: string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function catalogIdentity(identity: CatalogIdentity): {
  filePath: string;
  fingerprint: string;
} {
  const profile = identity.profile || "default";
  const safeProfile = profile.replace(/[^A-Za-z0-9_.-]/g, "_");
  const hostHash = shortHash(identity.host);
  const directory =
    identity.customPath ??
    path.join(os.homedir(), ".cache", "mcp-mysql-bastion", "catalog");
  return {
    filePath: path.join(directory, `${safeProfile}-${hostHash}.json`),
    fingerprint: shortHash(`${identity.host}\u0000${identity.user}`),
  };
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

export class SchemaCatalog {
  private readonly store: CatalogStore;
  private readonly collector: CatalogCollector;

  constructor(private readonly options: CatalogOptions) {
    this.store = new CatalogStore(options);
    this.collector = new CatalogCollector(this.store, {
      schemas: options.appSchemas.map((entry) => entry.schema),
      ttlHours: options.ttlHours,
      isPIIColumn: options.isPIIColumn,
    });
  }

  isEnabled(): boolean {
    return this.store.isEnabled();
  }

  startInventory(): void {
    if (!this.isEnabled()) return;
    // Deliberately not forced. MCP clients start a fresh server per session,
    // so forcing here would rescan on every session and make
    // MYSQL_CATALOG_TTL_HOURS meaningless for the inventory. An empty or
    // expired inventory still refreshes: `inventoryNeedsRefresh` treats a
    // missing `scannedAt` as expired.
    void this.collector.collectInventory(false).catch((error) => {
      console.error(
        `[catalog] inventory scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private resolveTable(input: string): {
    schema: string;
    table: string;
    entry: CatalogTable;
  } | null {
    const cleaned = input.replace(/`/g, "").trim();
    const dot = cleaned.indexOf(".");
    const requestedSchema = dot === -1 ? null : cleaned.slice(0, dot);
    const requestedTable = dot === -1 ? cleaned : cleaned.slice(dot + 1);
    const catalog = this.store.snapshot();
    const matches: Array<{ schema: string; table: string; entry: CatalogTable }> = [];
    for (const [schemaName, schema] of Object.entries(catalog.schemas)) {
      if (requestedSchema && !sameName(schemaName, requestedSchema)) continue;
      for (const [tableName, entry] of Object.entries(schema.tables)) {
        if (sameName(tableName, requestedTable)) {
          matches.push({ schema: schemaName, table: tableName, entry });
        }
      }
    }
    if (matches.length === 1) return matches[0];
    if (!requestedSchema && this.options.defaultSchema) {
      return (
        matches.find((match) => sameName(match.schema, this.options.defaultSchema as string)) ??
        null
      );
    }
    return null;
  }

  private async ensureKnownTable(input: string): Promise<{
    schema: string;
    table: string;
    entry: CatalogTable;
  }> {
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
    if (Object.values(this.store.snapshot().schemas).every(
      (schema) => schema.scannedAt === null,
    )) {
      await this.collector.collectInventory(false);
    }
    return renderMap(this.store.snapshot());
  }

  async search(query: string, requestedLimit?: number): Promise<string> {
    if (!this.isEnabled()) throw new Error("The schema catalog is disabled.");
    // Same cold-start guard as `map`. Without it the first search of a session
    // reads an empty snapshot and returns no hits, which reads to the model as
    // "no such table" rather than "not scanned yet".
    if (Object.values(this.store.snapshot().schemas).every(
      (schema) => schema.scannedAt === null,
    )) {
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
    const current = this.resolveTable(`${resolved.schema}.${resolved.table}`);
    if (!current) throw new Error(`Table disappeared during refresh: ${input}`);
    return renderDescribe(
      `${current.schema}.${current.table}`,
      current.entry,
      this.options.isPIIColumn,
    );
  }

  async listTables(): Promise<TableRow[]> {
    if (!this.isEnabled()) return [];
    const initial = this.store.snapshot();
    if (Object.values(initial.schemas).every(
      (schema) => schema.scannedAt === null,
    )) {
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
    if (!this.isEnabled()) {
      return { references: [], normalizedSql: null, joins: [], columns: [] };
    }
    const prepared = prepareCatalogQuery(sql);
    if (prepared.columns.some(this.options.isPIIColumn)) {
      prepared.normalizedSql = null;
    }
    return prepared;
  }

  afterQuery(
    prepared: PreparedCatalogQuery,
    result: { content?: Array<{ type: string; text: string }>; isError?: boolean },
    error?: unknown,
  ): void {
    if (!this.isEnabled() || prepared.references.length === 0) return;
    setImmediate(() => {
      void this.processQuery(prepared, result, error).catch((cause) => {
        console.error(
          `[catalog] post-query update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
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

    if (succeeded && Object.values(this.store.snapshot().schemas).every(
      (schema) => schema.scannedAt === null,
    )) {
      await this.collector.collectInventory(false);
    }
    const resolved = references
      .map((reference) =>
        this.resolveTable(
          reference.schema
            ? `${reference.schema}.${reference.table}`
            : reference.table,
        ),
      )
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const unique = new Map(
      resolved.map((value) => [`${value.schema}.${value.table}`, value]),
    );
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
        if (prepared.normalizedSql) {
          const fingerprint = table.usage.fingerprints[prepared.normalizedSql] ?? {
            count: 0,
            successCount: 0,
            failureCount: 0,
            lastUsedAt: now,
          };
          fingerprint.count += 1;
          if (succeeded) fingerprint.successCount += 1;
          else fingerprint.failureCount += 1;
          fingerprint.lastUsedAt = now;
          table.usage.fingerprints[prepared.normalizedSql] = fingerprint;
          const oldest = Object.entries(table.usage.fingerprints).sort(
            ([, a], [, b]) => a.lastUsedAt.localeCompare(b.lastUsedAt),
          );
          while (oldest.length > 100) {
            const [key] = oldest.shift() as [string, unknown];
            delete table.usage.fingerprints[key];
          }
        }
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
          if (existing) existing.count += 1;
          else catalog.joins.push({ a: endpoints[0], b: endpoints[1], count: 1 });
        }
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
  }

  markTableStale(input: string): void {
    const resolved = this.resolveTable(input);
    if (!resolved) return;
    this.store.update((catalog) => {
      const table = catalog.schemas[resolved.schema]?.tables[resolved.table];
      if (table) table.detailStale = true;
    });
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

export type { CatalogOptions, TableReference } from "./types.js";
