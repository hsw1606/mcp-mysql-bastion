import { execFile } from "child_process";
import { promisify } from "util";
import type { CatalogStore } from "./store.js";
import type { AppSchemaEntry } from "../types/index.js";

const execFileAsync = promisify(execFile);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
// Every git call here is a local read that takes about 150ms. A call that has
// not returned in ten seconds is wedged, and shutdown waits on these tasks
// before tearing down the tunnel, so it must not wait forever.
const GIT_TIMEOUT_MS = 10_000;

interface DocumentManagerOptions {
  repo: string | null;
  ref: string | null;
  appSchemas: readonly AppSchemaEntry[];
}

export interface ResolvedDocumentLink {
  schema: string;
  table: string;
  doc: string;
}

interface DiffEntry {
  status: "A" | "D" | "M" | "R";
  oldPath?: string;
  path: string;
}

function modelPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("model.md"));
}

function parseDiff(output: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const kind = fields[0]?.[0] as DiffEntry["status"] | undefined;
    if (kind === "R" && fields[1] && fields[2]) {
      entries.push({ status: "R", oldPath: fields[1], path: fields[2] });
    } else if (
      (kind === "A" || kind === "D" || kind === "M") &&
      fields[1]
    ) {
      entries.push({ status: kind, path: fields[1] });
    }
  }
  return entries;
}

function linkedDocumentPaths(catalog: ReturnType<CatalogStore["snapshot"]>): Set<string> {
  const linked = new Set<string>();
  for (const schema of Object.values(catalog.schemas)) {
    for (const table of Object.values(schema.tables)) {
      if (table.curated.doc) linked.add(table.curated.doc.path);
    }
  }
  return linked;
}

function refreshUnlinked(catalog: ReturnType<CatalogStore["snapshot"]>): void {
  const linked = linkedDocumentPaths(catalog);
  catalog.docs.unlinked = catalog.docs.paths.filter((path) => !linked.has(path));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class CatalogDocuments {
  private attempted = false;
  private wakePromise: Promise<void> | null = null;
  // Set when a reset lands on a wake that is already in flight. That wake read
  // the ref before the reset, so its answer is the stale one the caller is
  // discarding, and the next ensureAwake has to start a fresh read.
  private wakeSpent = false;
  private disabledReason: string | null = null;

  constructor(
    private readonly store: CatalogStore,
    private readonly options: DocumentManagerOptions,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.options.repo && this.options.ref);
  }

  isAvailable(): boolean {
    return this.isConfigured() && this.disabledReason === null;
  }

  error(): string | null {
    return this.disabledReason;
  }

  /**
   * Forget that this session already woke the document axis, so the next wake
   * re-reads the ref. The server never runs `git fetch`, so this is the only
   * way a fetch the user ran mid-session becomes visible without a restart.
   * Clearing the failure reason too gives a repaired repository a second
   * chance: otherwise one transient git error disables documents for good.
   */
  resetWake(): void {
    this.attempted = false;
    this.disabledReason = null;
    this.wakeSpent = this.wakePromise !== null;
  }

  private async git(args: string[]): Promise<string> {
    if (!this.options.repo) throw new Error("MYSQL_DOCS_REPO is not configured.");
    console.error(`[catalog] git -C ${this.options.repo} ${args.join(" ")}`);
    const { stdout } = await execFileAsync("git", ["-C", this.options.repo, ...args], {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  }

  async ensureAwake(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error(
        "The document catalog is disabled because MYSQL_DOCS_REPO or MYSQL_CODE_BRANCH is not configured.",
      );
    }
    if (this.disabledReason) throw new Error(this.disabledReason);
    if (this.attempted && !this.wakePromise) return;
    let promise = this.wakePromise;
    if (!promise || this.wakeSpent) {
      this.attempted = true;
      // A spent wake is queued behind rather than raced. Two concurrent wakes
      // rewrite the same document paths, and the older one landing last would
      // persist exactly the commit the reset asked to replace. Its failure is
      // swallowed so a repaired repository still gets its fresh read.
      const previous =
        promise && this.wakeSpent ? promise.catch(() => undefined) : null;
      this.wakeSpent = false;
      promise = (previous ?? Promise.resolve())
        .then(() => this.wake())
        .catch((error) => {
          this.disabledReason =
            `The document catalog is unavailable: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`[catalog] document axis disabled: ${this.disabledReason}`);
          throw new Error(this.disabledReason);
        });
      this.wakePromise = promise;
    }
    try {
      await promise;
    } finally {
      // Only the call that installed this handle clears it. Clearing from every
      // awaiter let a late one drop a newer wake's handle, and the next
      // ensureAwake then returned before the paths were populated.
      if (this.wakePromise === promise) this.wakePromise = null;
    }
  }

  private async wake(): Promise<void> {
    const ref = this.options.ref as string;
    const commit = (await this.git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    const cached = this.store.docsView();
    if (cached.refCommit === commit) return;

    let entries: DiffEntry[] | null = null;
    if (cached.refCommit) {
      try {
        entries = parseDiff(
          await this.git([
            "diff",
            "--name-status",
            cached.refCommit,
            commit,
            "--",
            "*model.md",
          ]),
        );
      } catch (error) {
        console.error(
          `[catalog] cached document commit is unavailable; rebuilding path list: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (entries === null) {
      const paths = modelPaths(
        await this.git(["ls-tree", "-r", "--name-only", commit]),
      );
      this.store.update((catalog) => {
        catalog.docs.paths = paths;
        for (const schema of Object.values(catalog.schemas)) {
          for (const table of Object.values(schema.tables)) {
            if (table.curated.doc && !paths.includes(table.curated.doc.path)) {
              delete table.curated.doc;
            }
          }
        }
        refreshUnlinked(catalog);
      });
    } else {
      this.store.update((catalog) => {
        for (const entry of entries as DiffEntry[]) {
          if (entry.status === "M") continue;
          if (entry.status === "A") {
            if (!catalog.docs.paths.includes(entry.path)) {
              catalog.docs.paths.push(entry.path);
            }
            continue;
          }
          if (entry.status === "D") {
            catalog.docs.paths = catalog.docs.paths.filter(
              (path) => path !== entry.path,
            );
            for (const schema of Object.values(catalog.schemas)) {
              for (const table of Object.values(schema.tables)) {
                if (table.curated.doc?.path === entry.path) {
                  delete table.curated.doc;
                }
              }
            }
            continue;
          }
          const oldPath = entry.oldPath as string;
          catalog.docs.paths = catalog.docs.paths.map((path) =>
            path === oldPath ? entry.path : path,
          );
          if (!catalog.docs.paths.includes(entry.path)) {
            catalog.docs.paths.push(entry.path);
          }
          for (const schema of Object.values(catalog.schemas)) {
            for (const table of Object.values(schema.tables)) {
              if (table.curated.doc?.path === oldPath) {
                table.curated.doc.path = entry.path;
              }
            }
          }
        }
        catalog.docs.paths = [...new Set(catalog.docs.paths)].sort();
        refreshUnlinked(catalog);
      });
    }

    let refUpdatedAt: string | null = null;
    try {
      const seconds = Number(
        (await this.git(["show", "-s", "--format=%ct", commit])).trim(),
      );
      if (Number.isFinite(seconds)) {
        refUpdatedAt = new Date(seconds * 1_000).toISOString();
      }
    } catch (error) {
      console.error(
        `[catalog] could not read document ref timestamp: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.store.update((catalog) => {
      catalog.docs.repo = this.options.repo;
      catalog.docs.ref = this.options.ref;
      catalog.docs.refCommit = commit;
      catalog.docs.refUpdatedAt = refUpdatedAt;
    });
    console.error(
      `[catalog] document paths refreshed: ${this.store.docsView().paths.length} files at ${ref}`,
    );
  }

  async list(schemaName: string): Promise<string> {
    await this.ensureAwake();
    const mapping = this.options.appSchemas.find(
      (entry) => entry.schema.toLowerCase() === schemaName.toLowerCase(),
    );
    if (!mapping) {
      throw new Error(`Schema "${schemaName}" is not declared in MYSQL_APP_SCHEMAS.`);
    }
    const catalog = this.store.snapshot();
    // The app name from MYSQL_APP_SCHEMAS is assumed to be the monorepo
    // directory, which is what narrows 91 documents down to the ~24 that can
    // belong to this schema. It is a convention, not a fact the server can
    // verify, so a prefix that matches nothing falls back to the full list
    // rather than reporting "no documents".
    const prefix = `apps/${mapping.app}/`;
    const inPrefix = catalog.docs.paths.filter((path) => path.startsWith(prefix));
    const scoped = inPrefix.length > 0;
    const selected = scoped ? inPrefix : catalog.docs.paths;
    const linkedTablesFor = (path: string): string[] =>
      Object.entries(catalog.schemas).flatMap(([knownSchema, schema]) =>
        Object.entries(schema.tables)
          .filter(([, table]) => table.curated.doc?.path === path)
          .map(([table]) => `${knownSchema}.${table}`),
      );
    const paths = selected.map((path) => ({
      path,
      linkedTables: linkedTablesFor(path),
    }));
    const outsidePrefix = catalog.docs.paths.length - inPrefix.length;
    const notice = scoped
      ? outsidePrefix > 0
        ? `${outsidePrefix}개 문서는 "${prefix}" 밖에 있어 제외했습니다. ` +
          "map의 unlinkedDocuments에 전체 목록이 있고, docs_read는 카탈로그에 " +
          "있는 어떤 경로든 읽습니다."
        : null
      : `"${prefix}" 로 시작하는 문서가 없어 카탈로그의 모든 문서를 반환했습니다. ` +
        `MYSQL_APP_SCHEMAS의 앱 이름("${mapping.app}")이 저장소 디렉토리와 다를 수 있습니다.`;
    const warning = this.staleWarning();
    return JSON.stringify(
      {
        schema: schemaName,
        app: mapping.app,
        ref: catalog.docs.ref,
        scopedToApp: scoped,
        paths,
        ...(notice ? { notice } : {}),
        ...(warning ? { warning } : {}),
      },
      null,
      2,
    );
  }

  async read(documentPath: string): Promise<string> {
    await this.ensureAwake();
    const catalog = this.store.snapshot();
    if (!catalog.docs.paths.includes(documentPath)) {
      throw new Error(
        `Document "${documentPath}" is not present at ${catalog.docs.ref}. Use docs_list or map to choose a cataloged path.`,
      );
    }
    const content = await this.git(["show", `${catalog.docs.ref}:${documentPath}`]);
    const warning = this.staleWarning();
    return warning ? `${warning}\n\n${content}` : content;
  }

  async link(links: ResolvedDocumentLink[]): Promise<string> {
    await this.ensureAwake();
    const snapshot = this.store.snapshot();
    for (const link of links) {
      if (!snapshot.docs.paths.includes(link.doc)) {
        throw new Error(
          `Document "${link.doc}" is not present at ${snapshot.docs.ref}.`,
        );
      }
      if (!snapshot.schemas[link.schema]?.tables[link.table]) {
        throw new Error(`Unknown table "${link.schema}.${link.table}".`);
      }
    }
    const now = new Date().toISOString();
    this.store.update((catalog) => {
      for (const link of links) {
        catalog.schemas[link.schema].tables[link.table].curated.doc = {
          path: link.doc,
          linkedBy: "model",
          linkedAt: now,
          linkedAtCommit: catalog.docs.refCommit,
        };
      }
      refreshUnlinked(catalog);
    });
    return JSON.stringify(
      {
        linked: links.map((link) => ({
          table: `${link.schema}.${link.table}`,
          doc: link.doc,
        })),
        ...(this.staleWarning() ? { warning: this.staleWarning() } : {}),
      },
      null,
      2,
    );
  }

  unlink(schemaName: string, tableName: string): string {
    const snapshot = this.store.snapshot();
    if (!snapshot.schemas[schemaName]?.tables[tableName]) {
      throw new Error(`Unknown table "${schemaName}.${tableName}".`);
    }
    this.store.update((catalog) => {
      catalog.schemas[schemaName].tables[tableName].curated.doc = null;
      refreshUnlinked(catalog);
    });
    return JSON.stringify(
      {
        table: `${schemaName}.${tableName}`,
        doc: null,
        status: "문서 없음 또는 연결 해제를 확인했습니다.",
        ...(this.staleWarning() ? { warning: this.staleWarning() } : {}),
      },
      null,
      2,
    );
  }

  staleWarning(): string | null {
    // On the query response path. Reads the document axis alone: a full
    // snapshot would clone every table's metadata to check one timestamp.
    const updatedAt = this.store.docsView().refUpdatedAt;
    if (!updatedAt) return null;
    const age = Date.now() - Date.parse(updatedAt);
    if (!Number.isFinite(age) || age <= THIRTY_DAYS_MS) return null;
    return (
      `[카탈로그 경고] ${this.options.ref}의 마지막 커밋이 30일 이상 지났습니다. ` +
      "필요하면 사용자가 문서 저장소에서 git fetch를 실행해야 합니다."
    );
  }

  documentCommand(documentPath: string): string | null {
    if (!this.options.repo || !this.options.ref) return null;
    return `git -C ${shellQuote(this.options.repo)} show ${shellQuote(`${this.options.ref}:${documentPath}`)}`;
  }
}
