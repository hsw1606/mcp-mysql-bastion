import type { CatalogIndexFacts } from "../catalog/types.js";
import type { QualifierMap } from "./utils.js";

/**
 * `max_execution_time`이 다 되어 MySQL이 문장을 취소할 때 내는 오류인
 * `ER_QUERY_TIMEOUT`. 메시지는 빌드에 따라 번역되어 나오므로 숫자 코드로 판별한다.
 */
const ER_QUERY_TIMEOUT = 3024;

export function isQueryTimeoutError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const candidate = error as { errno?: unknown; code?: unknown };
  return candidate.errno === ER_QUERY_TIMEOUT || candidate.code === "ER_QUERY_TIMEOUT";
}

/**
 * 행 추정치와, 그 숫자가 무엇을 센 것인지를 함께 담는다.
 *
 * EXPLAIN의 행 수치는 서로 바꿔 쓸 수 없다. `rows_examined_per_scan`은 그 테이블을
 * 한 번 스캔할 때의 값이고, `rows_produced_per_join`은 그 단계가 내보내는 값이다.
 * 둘을 갈라 주는 것은 필드 이름뿐이다. 그래서 그냥 `rows`로 뭉개지 않고 숫자와 함께
 * 들고 다닌다.
 */
export interface PlanRows {
  value: number;
  /** 라벨로 출력한다. 필드가 달고 있던 단서를 읽는 쪽에 그대로 넘긴다. */
  unit: string;
}

/** 옵티마이저가 읽겠다고 말한 그대로의 테이블 하나. */
export interface PlanTable {
  /** EXPLAIN이 보고한 그대로. 쿼리가 별칭을 썼다면 별칭이 들어온다. */
  name: string;
  accessType: string;
  rows: PlanRows | null;
  key: string | null;
  /** 플랜의 `attached_condition`을 그대로 옮긴 값. */
  condition: string | null;
  /**
   * 이 노드가 테이블이 아니라 하나의 단계일 때 true다. union 결과, 구체화한
   * 서브쿼리, 파생 테이블이 여기 해당한다. EXPLAIN은 이런 노드에도 실제 테이블처럼
   * `table_name`을 붙인다 - `<union1,2>`, 파생 테이블이면 쿼리가 준 별칭인데,
   * 철자만으로는 테이블 이름과 구분되지 않는다.
   */
  synthetic: boolean;
}

const ROW_FIELDS: ReadonlyArray<{ key: string; unit: string }> = [
  { key: "rows_examined_per_scan", unit: "rows/scan" },
  { key: "rows", unit: "rows" },
  { key: "rows_produced_per_join", unit: "rows out" },
];

function readRows(node: Record<string, unknown>): PlanRows | null {
  for (const { key, unit } of ROW_FIELDS) {
    const value = node[key];
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric === "number" && Number.isFinite(numeric)) return { value: numeric, unit };
  }
  return null;
}

/**
 * `EXPLAIN FORMAT=JSON` 플랜에 있는 모든 테이블 노드를, 플랜이 나열한 순서 그대로
 * 모은다 — 그 순서가 곧 조인 순서이고, 지킬 값어치가 있다.
 *
 * MySQL이 테이블을 품는 구조 — `nested_loop`, `ordering_operation`,
 * `grouping_operation`, `materialized_from_subquery`, `union_result` 등 — 를
 * 따라가는 대신 문서 전체를 훑는다. 예상하지 못한 플랜 모양을 만나면 테이블을 덜
 * 찾을 뿐, 터지지는 않는다.
 *
 * 여기서 하는 일은 추출이지 해석이 아니다. 플랜이 좋은지는 아무것도 판단하지 않는다.
 */
export function collectPlanTables(node: unknown): PlanTable[] {
  const out: PlanTable[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value == null || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.access_type === "string" && typeof obj.table_name === "string") {
      out.push({
        name: obj.table_name,
        accessType: obj.access_type,
        rows: readRows(obj),
        key: typeof obj.key === "string" ? obj.key : null,
        condition:
          typeof obj.attached_condition === "string" && obj.attached_condition
            ? obj.attached_condition
            : null,
        synthetic:
          obj.table_name.startsWith("<") || "materialized_from_subquery" in obj,
      });
    }
    for (const child of Object.values(obj)) visit(child);
  };
  visit(node);
  return out;
}

/**
 * `EXPLAIN FORMAT=JSON`이 돌려주는 한 행 한 컬럼짜리 본문을 파싱한다.
 * 예상 밖의 값이면 null을 돌려준다 — 읽지 못한 플랜은 빈 플랜이 아니라 플랜을
 * 구하지 못했다고 보고한다.
 */
export function parseExplainPayload(rows: unknown): unknown | null {
  const first = Array.isArray(rows) ? rows[0] : rows;
  if (first == null || typeof first !== "object") return null;
  const value = Object.values(first as Record<string, unknown>)[0];
  if (typeof value === "object" && value !== null) return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export interface DiagnosisInput {
  timeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** 파싱한 플랜. EXPLAIN을 돌리지 못했거나 읽지 못했으면 null이다. */
  plan: unknown | null;
  qualifiers: QualifierMap;
  /** 플랜이 지목한 테이블의 카탈로그 인덱스 정보. 모르면 null이다. */
  lookupIndexes: (name: string) => CatalogIndexFacts | null;
}

/**
 * 보고서에 덧붙이는 JSON 플랜의 상한.
 *
 * 폭이 넓은 쿼리의 플랜은 수십 킬로바이트에 이르고, 그 위의 테이블별 요약이 이미
 * 판단의 근거를 담고 있다. 이 크기를 넘으면 잘라 넣지 않고 통째로 뺀다. 반쪽짜리
 * JSON은 문서가 아니라 읽는 쪽이 추측해야 하는 무언가이기 때문이다.
 */
const MAX_PLAN_JSON_CHARS = 12_000;

function formatRows(rows: PlanRows | null): string {
  if (rows == null) return "rows: unknown";
  return `${rows.unit}: ~${Math.round(rows.value).toLocaleString("en-US")}`;
}

/** `IDX_name(colA, colB)` 형태. 인덱스 순서대로 쓴다 — 쓸모를 가르는 순서다. */
function describeIndexes(facts: CatalogIndexFacts): string {
  if (facts.indexes.length === 0) return "none recorded";
  return facts.indexes
    .map((index) => `${index.name}(${index.columns.join(", ")})`)
    .join(", ");
}

/** 두 절이 함께 쓸 이름을 붙여 둔 플랜 노드. */
interface LabelledTable {
  table: PlanTable;
  /** 스키마까지 붙인 테이블 이름. 인덱스 목록은 이 값으로 중복을 제거한다. */
  canonical: string;
  /** `canonical`에, EXPLAIN이 별칭을 썼다면 그 별칭을 덧붙인 이름. */
  label: string;
}

/**
 * 어느 절에서든 출력하기 전에, 플랜 노드마다 이름을 하나로 정해 둔다.
 *
 * 쿼리가 별칭을 썼다면 EXPLAIN은 별칭을 이름으로 적는다. 그래서 요약에는 `i`,
 * 인덱스 목록에는 `haulla.invoice`가 나오면 둘을 짝짓는 일이 읽는 쪽에 남는다 -
 * qualifier 맵이 이미 해 둔 일이다. 플랜의 조건문이 별칭으로 쓰여 있으므로 별칭은
 * 괄호 안에 남겨 둔다.
 */
function labelTables(input: DiagnosisInput, tables: PlanTable[]): LabelledTable[] {
  return tables.map((table) => {
    if (table.synthetic) return { table, canonical: table.name, label: table.name };
    const facts = input.lookupIndexes(table.name);
    const resolved = input.qualifiers.get(table.name.toLowerCase());
    const canonical = facts
      ? `${facts.schema}.${facts.table}`
      : resolved
        ? `${resolved.schema ? `${resolved.schema}.` : ""}${resolved.table}`
        : table.name;
    const alias = table.name.toLowerCase();
    const named =
      canonical.toLowerCase() === alias || canonical.toLowerCase().endsWith(`.${alias}`);
    return { table, canonical, label: named ? canonical : `${canonical} (${table.name})` };
  });
}

/**
 * 이 플랜이 건드린 테이블에 대해 카탈로그가 아는 것.
 *
 * 없다는 것은 사실이 아니라 모른다는 뜻으로 보고한다. "카탈로그에 이 테이블의 인덱스
 * 목록이 없다"와 "이 테이블에는 그 컬럼을 덮는 인덱스가 없다"는 요약에서 비슷하게
 * 읽히지만 같은 주장이 아니다. 사용자에게 포기하라고 말할 근거가 되는 쪽은 하나뿐이다.
 */
function renderIndexSection(input: DiagnosisInput, tables: LabelledTable[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { table, canonical } of tables) {
    // 단계에는 모를 만한 인덱스 목록 자체가 없으므로 카탈로그에 묻지 않는다. 대신
    // 그렇다고 적어 주면 모델 자신의 플랜을 모델에게 되읽어 주는 꼴이 된다. 조회는
    // 이름으로 하는데, 파생 테이블의 별칭이 어떤 실제 테이블의 이름일 수도 있다.
    // 건너뛰는 덕에 그 실제 테이블의 인덱스가 별칭의 것으로 보고되는 일도 막는다.
    if (table.synthetic) continue;
    if (seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());

    const facts = input.lookupIndexes(table.name);
    if (!facts) {
      lines.push(
        `  ${canonical}: not in the local catalog - its index list is unknown here, so absence of an index cannot be concluded.`,
      );
      continue;
    }
    const staleness = facts.detailStale
      ? "  (marked stale - may be out of date)"
      : facts.detailScannedAt === null
        ? "  (not scanned in detail yet - may be incomplete)"
        : "";
    lines.push(`  ${canonical}: ${describeIndexes(facts)}${staleness}`);
  }
  return lines;
}

/**
 * 취소된 쿼리의 결과 행을 대신해 돌려주는 텍스트.
 *
 * 무슨 일이 있었는지와 옵티마이저가 무엇이라 했는지까지만 알리고 멈춘다. 플랜과
 * 인덱스 목록은 왕복을 들일 값어치가 있는 사실이지만, 그 뜻을 정하는 일은 아니다.
 * 여기에 분류기를 두면 JSON 문서 하나만 보게 된다. 반면 이 글을 읽는 모델은 문장과
 * 스키마, 사용자가 실제로 물은 질문까지 본다 — 그러니 어느 테이블이 문제인지, 고쳐
 * 쓴 쿼리가 그 질문을 그대로 지키는지는 모델이 판단할 몫이다.
 *
 * 남기는 것은 모델이 여기서 스스로 얻을 수 없는 것뿐이다. EXPLAIN이 이미 돌았다는
 * 사실(그래서 다시 돌리거나 문장을 재실행하지 않도록), 플랜 자체, 카탈로그의 인덱스
 * 목록, `access_type`을 읽는 한 가지 비직관적인 규칙, 그리고 재시도의 한계다.
 *
 * 이 실행기가 돌려주는 다른 거절문과 나란히 놓이도록 영어로 쓴다. 사용자에게 선택지를
 * 내밀 때는 모델이 번역한다.
 */
export function renderTimeoutDiagnostic(input: DiagnosisInput): string {
  const lines: string[] = [
    `[ABORTED] Query cancelled after exceeding the ${input.timeoutSeconds}s execution limit. No rows were returned.`,
    "",
  ];

  if (!input.plan) {
    lines.push(
      "[EXPLAIN UNAVAILABLE] The server tried to read the execution plan and could not.",
      "Do NOT run EXPLAIN yourself, and do NOT re-run this statement unchanged - it would be cancelled again.",
      "",
      ...renderNextSection(input, false),
    );
    return lines.join("\n");
  }

  const tables = labelTables(input, collectPlanTables(input.plan));

  lines.push(
    "[EXPLAIN ALREADY RUN] The server ran EXPLAIN FORMAT=JSON on this statement and attached the",
    "result below. Do NOT run EXPLAIN yourself, and do NOT re-run this statement unchanged.",
    "",
  );

  if (tables.length > 0) {
    lines.push("[PLAN BY TABLE] in join order.");
    tables.forEach(({ table, label }, i) => {
      lines.push(
        `  ${i + 1}. ${label} - access: ${table.accessType}, ${formatRows(table.rows)}, key: ${table.key ?? "none"}`,
      );
      if (table.condition) lines.push(`     condition: ${table.condition}`);
    });
    lines.push(
      "  Reading access: ALL is a full table scan and `index` is a full index scan - both",
      "  read every row. A non-empty key does NOT mean the filter was narrowed; a full index",
      "  scan reports one too. const, eq_ref, ref and range did narrow the table.",
      "  rows/scan is per scan of that table, so an inner table of a join is read once for",
      "  every row the step above it produced - multiply before calling it cheap.",
      "",
    );
  } else {
    lines.push(
      "[PLAN BY TABLE] no table nodes were recognised in this plan - read the raw plan below.",
      "",
    );
  }

  const indexLines = renderIndexSection(input, tables);
  if (indexLines.length > 0) {
    lines.push(
      "[INDEXES] from the local schema catalog, for the tables above:",
      ...indexLines,
      "",
    );
  }

  const planJson = JSON.stringify(input.plan, null, 2);
  if (planJson.length <= MAX_PLAN_JSON_CHARS) {
    lines.push("[FULL PLAN]:", planJson, "");
  } else {
    lines.push(
      `[FULL PLAN] omitted: ${planJson.length.toLocaleString("en-US")} characters, too large to include.`,
      "The per-table summary above lists every table the plan touched.",
      "",
    );
  }

  lines.push(...renderNextSection(input, true));
  return lines.join("\n");
}

/**
 * 취소된 뒤에 고를 수 있는 선택지들. 무엇을 고르라는 말은 하지 않는다.
 *
 * 대안 없는 금지는 추측할 자리를 옮길 뿐이라 선택지를 낱낱이 적는다 — 다만 선택지일
 * 뿐 권고는 아니다. 여기서 유일하게 단단한 규칙은 재시도 한계다. 이것이 없으면 모델은
 * 애초에 끝날 리 없던 쿼리에 제한 시간을 계속 올려 댄다.
 */
function renderNextSection(input: DiagnosisInput, hasPlan: boolean): string[] {
  const canExtend = input.timeoutSeconds < input.maxTimeoutSeconds;
  const lines = [
    hasPlan
      ? "[NEXT] Decide from the plan and index lists above, then take exactly one of these:"
      : "[NEXT] Without a plan, take exactly one of these:",
    "  1. Rewrite the query so the optimizer can narrow the scan - an indexed filter, a column",
    "     compared directly instead of wrapped in a function, a tighter range, an aggregate",
    "     instead of raw rows, or a LIMIT - then retry once. No need to ask the user first,",
    "     as long as the rewrite still answers what they asked.",
  ];
  if (canExtend) {
    lines.push(
      `  2. Retry the statement unchanged with timeout_seconds: ${input.maxTimeoutSeconds}. Worth it only if`,
      hasPlan
        ? "     the plan looks sound and the query was merely slow. Available once - if it fails"
        : "     you have reason to think the query was merely slow. Available once - if it fails",
      "     again, stop and report; do not raise the limit further.",
    );
  } else {
    lines.push(
      `  2. A longer limit is NOT available: this already ran at the ${input.maxTimeoutSeconds}s ceiling, which is the`,
      "     maximum this server allows. Do not ask for more time.",
    );
  }
  lines.push(
    "  3. Stop and ask the user how to proceed. Do this when no rewrite preserves what they",
    "     asked for - for example when no index covers the column they need to filter on.",
    "     Give them concrete choices in their own language and in domain terms: a different",
    "     column to filter on, requesting an index (not possible from this session), or",
    "     running the query outside this server. Never show them tool argument names.",
  );
  return lines;
}
