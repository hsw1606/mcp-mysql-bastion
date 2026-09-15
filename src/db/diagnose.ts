import type { CatalogIndexFacts } from "../catalog/types.js";
import type { QualifierMap } from "./utils.js";

/**
 * MySQL's error for a statement it cancelled because `max_execution_time` ran
 * out: `ER_QUERY_TIMEOUT`. Matched on the numeric code rather than the message,
 * which is localised on some builds.
 */
const ER_QUERY_TIMEOUT = 3024;

export function isQueryTimeoutError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const candidate = error as { errno?: unknown; code?: unknown };
  return candidate.errno === ER_QUERY_TIMEOUT || candidate.code === "ER_QUERY_TIMEOUT";
}

/** One table as the optimizer said it would read it. */
export interface PlanTable {
  /** As EXPLAIN reports it: the alias when the query used one. */
  name: string;
  accessType: string;
  rows: number | null;
  key: string | null;
  /** The plan's `attached_condition`, verbatim. */
  condition: string | null;
}

function readRows(node: Record<string, unknown>): number | null {
  for (const key of ["rows_examined_per_scan", "rows", "rows_produced_per_join"]) {
    const value = node[key];
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric === "number" && Number.isFinite(numeric)) return numeric;
  }
  return null;
}

/**
 * Every table node in an `EXPLAIN FORMAT=JSON` plan, in the order the plan
 * lists them — which is the join order, and worth preserving.
 *
 * Walks the whole document rather than following the shapes MySQL nests tables
 * under — `nested_loop`, `ordering_operation`, `grouping_operation`,
 * `materialized_from_subquery`, `union_result`, and more. A plan shape we did
 * not anticipate degrades to finding fewer tables, never to a crash.
 *
 * This is extraction, not interpretation: nothing here decides whether a plan
 * is good.
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
      });
    }
    for (const child of Object.values(obj)) visit(child);
  };
  visit(node);
  return out;
}

/**
 * The single-column, single-row payload of `EXPLAIN FORMAT=JSON`, parsed.
 * Returns null for anything unexpected — a plan we cannot read is reported as
 * an unavailable plan, not as an empty one.
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
  /** Parsed plan, or null when EXPLAIN could not be run or read. */
  plan: unknown | null;
  qualifiers: QualifierMap;
  /** Catalog index facts for a table the plan named, or null if unknown. */
  lookupIndexes: (name: string) => CatalogIndexFacts | null;
}

/**
 * Ceiling on the JSON plan appended to the report.
 *
 * A plan for a wide query can run to tens of kilobytes, and the per-table
 * summary above it already carries what a decision turns on. Past this size the
 * JSON is dropped rather than cut, because half a JSON document is not a
 * document — it is something the reader has to guess at.
 */
const MAX_PLAN_JSON_CHARS = 12_000;

function formatRows(rows: number | null): string {
  if (rows == null) return "unknown";
  return `~${Math.round(rows).toLocaleString("en-US")}`;
}

/** `IDX_name(colA, colB)`, in index order — the order that decides usability. */
function describeIndexes(facts: CatalogIndexFacts): string {
  if (facts.indexes.length === 0) return "none recorded";
  return facts.indexes
    .map((index) => `${index.name}(${index.columns.join(", ")})`)
    .join(", ");
}

/**
 * What the catalog knows about the tables this plan touched.
 *
 * Absence is reported as ignorance, never as fact. "The catalog has no index
 * list for this table" and "this table has no index on that column" read alike
 * in a summary and are not the same claim, and only one of them justifies
 * telling a user to give up.
 */
function renderIndexSection(input: DiagnosisInput, tables: PlanTable[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const table of tables) {
    const resolved = input.qualifiers.get(table.name.toLowerCase());
    const label = resolved
      ? `${resolved.schema ? `${resolved.schema}.` : ""}${resolved.table}`
      : table.name;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());

    const facts = input.lookupIndexes(table.name);
    if (!facts) {
      lines.push(
        `  ${label}: not in the local catalog - its index list is unknown here, so absence of an index cannot be concluded.`,
      );
      continue;
    }
    const staleness = facts.detailStale
      ? "  (marked stale - may be out of date)"
      : facts.detailScannedAt === null
        ? "  (not scanned in detail yet - may be incomplete)"
        : "";
    lines.push(`  ${facts.schema}.${facts.table}: ${describeIndexes(facts)}${staleness}`);
  }
  return lines;
}

/**
 * The text returned in place of a cancelled query's rows.
 *
 * Reports what happened and what the optimizer said, and stops there. The plan
 * and the index lists are facts worth a round trip; deciding what they mean is
 * not. A classifier here sees one JSON document, while the model reading this
 * sees the statement, the schema, and the question the user actually asked —
 * so it is the model's call which table is the problem and whether a rewrite
 * preserves the question.
 *
 * What stays is only what the model cannot get for itself here: that EXPLAIN
 * has already run (so it does not run it again, or retry the statement), the
 * plan itself, the catalog's index lists, the one non-obvious
 * rule for reading `access_type`, and the bounds on retrying.
 *
 * Written in English to sit alongside the other refusals this executor returns.
 * The model translates when it puts the choice to the user.
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

  const tables = collectPlanTables(input.plan);

  lines.push(
    "[EXPLAIN ALREADY RUN] The server ran EXPLAIN FORMAT=JSON on this statement and attached the",
    "result below. Do NOT run EXPLAIN yourself, and do NOT re-run this statement unchanged.",
    "",
  );

  if (tables.length > 0) {
    lines.push("[PLAN BY TABLE] in join order.");
    tables.forEach((table, i) => {
      lines.push(
        `  ${i + 1}. ${table.name} - access: ${table.accessType}, rows: ${formatRows(table.rows)}, key: ${table.key ?? "none"}`,
      );
      if (table.condition) lines.push(`     condition: ${table.condition}`);
    });
    lines.push(
      "  Reading access: ALL is a full table scan and `index` is a full index scan - both",
      "  read every row. A non-empty key does NOT mean the filter was narrowed; a full index",
      "  scan reports one too. const, eq_ref, ref and range did narrow the table.",
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
 * The choices available after a cancellation, and nothing about which to take.
 *
 * A prohibition with no alternative just moves the guessing elsewhere, so the
 * options are spelled out — but they are options, not a recommendation. The
 * retry bound is the one hard rule here: without it the model raises the limit
 * again and again on a query that was never going to finish.
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
