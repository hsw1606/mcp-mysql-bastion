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
  CatalogIndexFacts,
  CatalogOptions,
  CatalogForgetScope,
  PreparedCatalogQuery,
  TableReference,
} from "./types.js";
import { emptyUsage, normalizeName, pruneJoins } from "./types.js";
import { prepareCatalogQuery, resultColumnNames } from "./usage.js";

const UNKNOWN_REFERENCE_REFRESH_COOLDOWN_MS = 60_000;
// 해석하지 못한 테이블 이름마다 항목 하나씩 쌓인다. 상한을 두어, 존재하지 않는
// 테이블을 계속 불러 대는 세션이 이 맵을 무한정 키우지 못하게 한다.
const UNKNOWN_REFERENCE_MEMORY_LIMIT = 256;
// 백그라운드 작업은 일부러 응답을 보낸 뒤에 시작하므로, 종료 시점에 이를 모두
// 흘려보낸다. 데드라인은 멈춰 버린 git 호출이나 쿼리가 터널을 내리기 전까지
// 종료 경로를 붙잡고 있지 못하게 막는다.
const CLOSE_DRAIN_DEADLINE_MS = 3_000;
const NOTE_MAX_LENGTH = 1_000;
const ALIAS_MAX_LENGTH = 200;
// 사람이 적어 넣은 텍스트는 자동 수집이 절대 덮어쓰지 못하는 유일한 값이다. 그래서
// 한도에 닿으면 파생 축처럼 오래된 항목을 밀어내지 않고 쓰기 자체를 거부한다. 둘 중
// 하나라도 상한에 닿은 테이블에 필요한 것은 조용히 사라지는 메모가 아니라 `forget`이다.
const NOTE_COUNT_LIMIT = 50;
const ALIAS_COUNT_LIMIT = 20;

/**
 * 참조를 유지하는 타이머와 그것을 취소하는 수단. 참조는 의도적이다. 참조를 놓은
 * 데드라인은 멈춘 작업만 이벤트 루프에 남았을 때 아예 발화하지 않는데, 그 상황이야말로
 * 데드라인이 존재하는 이유다. 경쟁이 끝난 뒤 타이머를 취소해서, 쓸모를 다한 타이머가
 * 살아남지 않게 한다.
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
  /** 로컬 SSH 포워딩을 거치기 전, 데이터베이스 엔드포인트의 고정된 식별자. */
  target: string;
  user: string;
  customPath?: string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * 파일 이름과 fingerprint는 반드시 같은 입력에서 만들어야 한다. fingerprint는 읽어
 * 들인 카탈로그를 재사용해도 되는지 결정하고, 값이 어긋나면 병합을 건너뛰고 덮어쓴다.
 * 그래서 fingerprint는 세지만 파일 이름은 세지 않는 입력이 있으면, 서로 다른 두 서버가
 * 한 파일을 쓰게 되어 각자 시작할 때 상대의 내용을 버리고 flush마다 짓뭉갠다. 사용자도
 * 양쪽에 들어가야 한다. 한 호스트의 두 계정은 권한이 달라서 보이는 테이블도 다르다.
 */
export function catalogIdentity(identity: CatalogIdentity): {
  filePath: string;
  fingerprint: string;
} {
  const profile = identity.profile || "default";
  const safeProfile = profile.replace(/[^A-Za-z0-9_.-]/g, "_");
  // 각 부분은 NUL로 구분한다. 호스트 이름이나 MySQL 사용자에는 NUL이 들어갈 수
  // 없으므로, 서로 다른 두 엔드포인트가 하나의 식별자로 뭉개지지 않는다.
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
 * 이름을 해석하는 단계와 항목을 수정하는 단계는 서로 떨어져 있다. 그 사이에 flush
 * 병합이나 백그라운드 인벤토리 스캔이 끼어들면, 데이터베이스에서 이미 사라진 테이블이
 * 카탈로그에서도 빠질 수 있다. 그럴 때는 예전처럼 `undefined` 프로퍼티를 읽게 두는
 * 것보다 이렇게 사정을 알려 주는 편이 낫다.
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
    // 일부러 강제하지 않는다. MCP 클라이언트는 세션마다 서버를 새로 띄우므로,
    // 여기서 강제하면 매 세션 다시 스캔하게 되고 인벤토리에 대해서는
    // MYSQL_CATALOG_TTL_HOURS가 무의미해진다. 비어 있거나 만료된 인벤토리는
    // 그래도 갱신된다. `inventoryNeedsRefresh`가 `scannedAt`이 없는 경우를
    // 만료로 보기 때문이다.
    this.trackBackgroundTask(
      this.collector.collectInventory(false).catch((error) => {
        console.error(
          `[catalog] inventory scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    );
  }

  /** `budget`은 기본 설명이 이 꼬리말 몫으로 남겨 둔 글자 수다. */
  toolDescriptionSuffix(budget: number): string {
    if (!this.isEnabled()) return "";
    return renderToolDescriptionSuffix(this.store.snapshot(), budget);
  }

  /**
   * hot-table 목록이 처음으로 비지 않게 되는 순간 한 번만 호출한다. 이 목록에는
   * 쿼리가 실제로 읽은 테이블만 들어가므로, 도구 설명이 바뀌는 시점은 인벤토리
   * 스캔이 아니라 첫 성공 쿼리다. 프로세스당 한 번만 부르며, 그래서 알림도 세션당
   * 한 번으로 묶인다.
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
   * 대소문자를 아무렇게나 쓴 참조로부터 정규 스키마 이름과 테이블 이름을 얻는다.
   * 스냅샷이 아니라 store의 이름 인덱스로 해석한다. 이 함수는 쿼리 한 건마다 여러 번
   * 돌기 때문에, 그때마다 카탈로그를 복제하면 응답마다 수십 밀리초씩 이벤트 루프가
   * 막혔다.
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

  /** 모델이나 사용자가 문서에 대한 판단을 이미 남겼는지 여부. */
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
        // 문서 저장소가 망가졌다고 데이터베이스 카탈로그까지 가려서는 안 된다.
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
    // `map`과 같은 콜드 스타트 방어다. 이것이 없으면 세션의 첫 검색이 빈 스냅샷을
    // 읽어 아무것도 찾지 못하고, 모델은 그 결과를 "아직 스캔 전"이 아니라 "그런
    // 테이블 없음"으로 읽는다.
    if (this.collector.inventoryNeedsRefresh()) {
      await this.collector.collectInventory(false);
    }
    const limit = Math.min(100, Math.max(1, requestedLimit ?? 20));
    return JSON.stringify(
      searchCatalog(this.store.snapshot(), query, limit),
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
    // 두 갱신이 모두 끝난 뒤에 테이블을 한 번만 읽는다. 문서 축을 깨우는 과정에서
    // 해당 ref에 파일이 없는 링크가 끊길 수 있으므로, 더 일찍 읽으면 방금 끊긴
    // 문서를 그대로 출력하게 된다.
    const entry = this.store.readTable(resolved.schema, resolved.table);
    if (!entry) throw new Error(`Table disappeared during refresh: ${input}`);
    return renderDescribe(
      `${resolved.schema}.${resolved.table}`,
      entry,
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
   * 서버가 스스로 알아내는 정보를 강제로 다시 수집한다.
   *
   * 자동 무효화는 오류에 기대어 돌아간다. 데이터베이스에 없는 컬럼이나 테이블을 부른
   * 쿼리가 그 항목을 stale로 표시한다. 이렇게 하면 카탈로그가 과하게 주장하는 경우만
   * 잡힌다. 반대 방향은 보지 못한다. 컬럼, 인덱스, 외래 키를 *추가하는* 마이그레이션은
   * 오류를 내지 않는다. 모델은 존재를 모르는 것을 부르지 않기 때문이다. 그래서 아무
   * 항목도 stale이 되지 않고, 카탈로그는 최대 TTL 한 주기 내내 실제보다 적게 보고한다.
   * 이 경우는 실패한 쿼리보다 나쁘다. 방금 추가된 `deletedAt`을 모르고 쓴 SQL은
   * 성공하면서 소프트 삭제된 행을 조용히 돌려준다. 이 함수는 그 구간을 수동으로
   * 빠져나오는 길이며, 비용은 쿼리 한 번이다.
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

    // 선언된 스키마 이름이 같은 이름의 테이블보다 우선한다. 이 환경에는 실제로
    // `call` 스키마가 있고, 스키마와 같은 이름의 테이블도 있을 수 있기 때문이다.
    // 점을 찍어 한정하면 언제나 테이블을 뜻한다.
    const declared = requested.includes(".")
      ? undefined
      : this.options.appSchemas.find((entry) => sameName(entry.schema, requested));
    if (declared) {
      // 쿼리 한 번이 선언된 모든 스키마를 훑으므로, 어떤 스키마를 지목했든 인벤토리
      // 전체를 다시 스캔한다. 결과에도 그 사실을 그대로 밝힌다.
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
      // 마이그레이션이 방금 만든 테이블은 아직 인벤토리에 없고, 바로 그것을 물어보려고
      // refresh를 부른다. 한정된 이름은 이 테이블이 존재한다는 명시적인 주장이므로
      // 확인에 쿼리 한 번을 쓴다. 한정되지 않은 낯선 단어는 오타일 가능성이 훨씬 커서
      // 쿼리를 쓰지 않는다.
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
      // 문서 저장소가 망가졌다고 데이터베이스 갱신까지 실패시켜서는 안 된다.
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

  /**
   * 테이블 하나의 인덱스 사실. 카탈로그가 보증할 수 없으면 null을 준다.
   *
   * 동기 함수이고 부수 효과가 없도록 일부러 그렇게 만들었다. 부르는 곳은 타임아웃
   * 진단 하나뿐인데, 이 진단은 쿼리가 이미 취소된 뒤에 돈다. 거기서 메타데이터를
   * 모으면 이 기능이 피하려던 왕복이 도로 생기고, 실패한 쿼리는 더 느려진다.
   * 카탈로그가 스캔한 적 없는 테이블은 그냥 null이 되고, 진단은 추측하는 대신 그
   * 사실을 말한다.
   */
  indexFacts(reference: TableReference): CatalogIndexFacts | null {
    if (!this.isEnabled()) return null;
    const resolved = this.resolveTable(
      reference.schema ? `${reference.schema}.${reference.table}` : reference.table,
    );
    if (!resolved) return null;
    return this.store.tableIndexes(resolved.schema, resolved.table);
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
              // 문서 축에만 생긴 실패는 CatalogDocuments가 로그로 남기고 기억한다.
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
        // 문서 축이 실패해도 데이터베이스 사용 기록 경로는 멀쩡히 돌아간다.
      });
    }
    const columns = resultColumnNames(result.content?.[0]?.text ?? "");
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
        // 쿼리가 테이블 하나만 건드렸더라도 그 컬럼이 어디 소속인지 확인한다. 이
        // 이름들은 결과의 키에서 왔으므로, 확인하지 않으면 `COUNT(*) AS total`
        // 같은 프로젝션이 `total`을 그 테이블의 컬럼으로 저장해 버리고, 이후
        // `describe`가 계속 그것을 보고한다.
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
   * 해석되지 않는 이름 때문에 방금 인벤토리를 갱신했다는 사실을 기록한다. 맵이 상한에
   * 닿으면 가장 오래된 항목부터 밀어낸다. Map은 삽입 순서로 순회하므로, 키를 다시 넣어
   * 두면 밀려나는 순서가 시간 순으로 유지된다.
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
        // stdio 클라이언트는 마지막 도구 결과를 받자마자 stdin을 닫는 경우가 많다.
        // 인벤토리, 상세, 문서 작업은 일부러 그 결과 뒤에 돌므로, 마지막 영속화
        // flush 전에 이들을 모두 흘려보낸다.
        //
        // 핵심은 데드라인이다. 우리를 부른 쪽이 우리 다음에 커넥션 풀과 SSH 터널을
        // 닫는데, 영영 끝나지 않는 작업이 있으면 둘 다 샌다. 이미 기록된 내용은
        // 그래도 저장된다.
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
  CatalogIndexFacts,
  CatalogOptions,
  TableReference,
} from "./types.js";
