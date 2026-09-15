import { readFileSync } from "node:fs";
import {
  CATALOG_VERSION,
  emptyTable,
  emptyUsage,
  type CatalogFile,
  type CatalogIndex,
  type CatalogIndexFacts,
  type CatalogSchema,
} from "../src/catalog/types.js";
import type { DiagnosisInput } from "../src/db/diagnose.js";
import type { QualifierMap } from "../src/db/utils.js";

/** 실제 MySQL 8의 `EXPLAIN FORMAT=JSON`에서 받아 둔 플랜. */
export function plan(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

export function index(name: string, ...columns: string[]): CatalogIndex {
  return { name, columns, unique: name === "PRIMARY", type: "BTREE" };
}

export function facts(
  schema: string,
  table: string,
  indexes: CatalogIndex[],
  overrides: Partial<CatalogIndexFacts> = {},
): CatalogIndexFacts {
  return {
    schema,
    table,
    indexes,
    pk: ["id"],
    rowsEstimate: null,
    detailScannedAt: "2026-09-15T00:00:00.000Z",
    detailStale: false,
    ...overrides,
  };
}

/**
 * `diagnoseTimeout`이 실제로 조립하는 방식 그대로 만든 진단 입력.
 *
 * 별칭 해석은 `diagnose.ts`가 아니라 `lookupIndexes` 클로저 안에 있다. 헬퍼가
 * 다르게 해석하면 렌더링 테스트는 통과하는데 운영은 다르게 도는 상태가 된다.
 *
 * 그래서 `catalog`를 이름으로 키잉한 객체가 아니라 목록으로 받는다. 객체로
 * 받으면 키가 테이블 이름 하나뿐이라 스키마를 버리게 되는데, 프로덕션은
 * 풀어낸 참조를 `{schema, table}` 통째로 넘기고 카탈로그가 거기서 다시
 * 한정한다. 스키마가 다른 동명 테이블에서 둘이 갈라진다.
 */
export function diagnosis(options: {
  plan: unknown;
  /** 소문자 별칭 또는 테이블 이름 → 그것이 가리키는 테이블. */
  qualifiers?: Record<string, { schema: string | null; table: string }>;
  /** 카탈로그가 아는 테이블들. 각 항목이 자기 스키마를 들고 있다. */
  catalog?: CatalogIndexFacts[];
  timeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): DiagnosisInput {
  const qualifiers: QualifierMap = new Map(Object.entries(options.qualifiers ?? {}));
  const catalog = options.catalog ?? [];
  return {
    timeoutSeconds: options.timeoutSeconds ?? 10,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 30,
    plan: options.plan,
    qualifiers,
    lookupIndexes: (name) => {
      // 프로덕션의 `diagnoseTimeout`과 같은 순서다. qualifier 맵으로 먼저
      // 풀고, 풀리지 않으면 이름을 그대로 참조로 넘긴다.
      const reference = qualifiers.get(name.toLowerCase()) ?? { schema: null, table: name };
      // 그리고 `CatalogStore.indexFacts`가 하는 일. 참조에 스키마가 있으면
      // 정확히 그 스키마의 테이블이어야 하고, 없을 때만 이름으로 찾는다.
      return (
        catalog.find(
          (entry) =>
            entry.table.toLowerCase() === reference.table.toLowerCase() &&
            (reference.schema === null ||
              entry.schema.toLowerCase() === reference.schema.toLowerCase()),
        ) ?? null
      );
    },
  };
}

/** 보고서에서 `[SECTION]` 블록 하나만 떼어낸다. 머리말 줄을 포함한다. */
export function section(report: string, name: string): string {
  const start = report.indexOf(`[${name}]`);
  if (start < 0) return "";
  const end = report.indexOf("\n\n", start);
  return report.slice(start, end < 0 ? undefined : end);
}

/** 인기 테이블을 줄 세우고 렌더링하는 데 필요한 만큼만 담은 카탈로그. */
export function catalogWith(
  reads: Array<{ schema: string; table: string; successCount: number; lastUsedAt?: string }>,
): CatalogFile {
  const schemas: Record<string, CatalogSchema> = {};
  for (const read of reads) {
    const schema = (schemas[read.schema] ??= {
      app: read.schema,
      scannedAt: null,
      tables: {},
    });
    schema.tables[read.table] = {
      ...emptyTable(),
      usage: { ...emptyUsage(), successCount: read.successCount, lastUsedAt: read.lastUsedAt ?? null },
    };
  }
  return {
    version: CATALOG_VERSION,
    profile: "test",
    fingerprint: "test",
    docs: { repo: null, ref: null, refCommit: null, refUpdatedAt: null, paths: [], unlinked: [] },
    schemas,
    joins: [],
  };
}
