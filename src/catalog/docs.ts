import { execFile } from "child_process";
import { promisify } from "util";
import type { CatalogStore } from "./store.js";
import type { AppSchemaEntry } from "../types/index.js";

const execFileAsync = promisify(execFile);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
// 여기서 부르는 git은 모두 150ms 남짓 걸리는 로컬 읽기다. 10초가 지나도 돌아오지
// 않았다면 멈춰 버린 것이다. 종료 과정은 터널을 닫기 전에 이 작업들을 기다리므로
// 무한정 기다리게 둘 수 없다.
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
  // 이미 진행 중인 wake 위로 reset이 들어왔을 때 세운다. 그 wake는 reset보다 먼저
  // ref를 읽었으므로 호출자가 버리려는 낡은 답을 들고 있다. 그래서 다음
  // ensureAwake는 읽기를 새로 시작해야 한다.
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
   * 이 세션이 문서 축을 이미 깨웠다는 사실을 잊는다. 그러면 다음 wake가 ref를 다시
   * 읽는다. 서버는 `git fetch`를 직접 실행하지 않으므로, 사용자가 세션 도중 실행한
   * fetch를 재시작 없이 반영하는 방법은 이것뿐이다. 실패 사유까지 지우는 것은
   * 복구된 저장소에 한 번 더 기회를 주기 위해서다. 그러지 않으면 일시적인 git 에러
   * 하나로 문서 기능이 영영 꺼진다.
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
      // 소진된 wake와 경쟁시키지 않고 그 뒤에 줄을 세운다. wake 둘이 동시에 돌면
      // 같은 문서 경로를 겹쳐 쓰는데, 오래된 쪽이 마지막에 도착하면 reset이 바꾸라고
      // 한 바로 그 커밋이 그대로 남는다. 앞선 실패는 삼킨다. 그래야 복구된 저장소도
      // 새로 읽은 결과를 받는다.
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
      // 이 핸들을 걸어 둔 호출만 그것을 지운다. 기다리는 쪽이 모두 지우게 두었더니,
      // 늦게 깨어난 호출이 더 새로운 wake의 핸들을 지워 버렸다. 그러면 다음
      // ensureAwake가 경로가 채워지기도 전에 반환했다.
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
    // MYSQL_APP_SCHEMAS의 앱 이름이 모노레포 디렉토리와 같다고 가정한다. 이 가정
    // 덕분에 문서 91개가 이 스키마에 속할 수 있는 24개 남짓으로 좁혀진다. 다만 이는
    // 관례일 뿐 서버가 확인할 수 있는 사실이 아니다. 그래서 prefix가 아무것도 걸러
    // 내지 못하면 "문서 없음"이라고 말하지 않고 전체 목록으로 물러난다.
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
    // 쿼리 응답 경로에서 돈다. 문서 축만 읽는다. 전체 스냅샷을 뜨면 타임스탬프
    // 하나 보려고 모든 테이블의 메타데이터를 복제하게 된다.
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
