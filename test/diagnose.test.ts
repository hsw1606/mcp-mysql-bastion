import { describe, expect, test } from "vitest";
import {
  collectPlanTables,
  isQueryTimeoutError,
  parseExplainPayload,
  renderTimeoutDiagnostic,
} from "../src/db/diagnose.js";
import { diagnosis, facts, index, plan, section } from "./helpers.js";

const ACCOUNT = { schema: null, table: "account" };

describe("isQueryTimeoutError", () => {
  test("max_execution_time으로 취소된 것을 알아본다", () => {
    expect(isQueryTimeoutError({ errno: 3024 })).toBe(true);
    expect(isQueryTimeoutError({ code: "ER_QUERY_TIMEOUT" })).toBe(true);
  });

  test("다른 실패까지 끌어오지 않는다", () => {
    expect(isQueryTimeoutError({ errno: 1146, code: "ER_NO_SUCH_TABLE" })).toBe(false);
    expect(isQueryTimeoutError(new Error("ECONNRESET"))).toBe(false);
    expect(isQueryTimeoutError(null)).toBe(false);
    expect(isQueryTimeoutError("3024")).toBe(false);
  });
});

describe("collectPlanTables", () => {
  test("조인 순서를 유지한다", () => {
    expect(collectPlanTables(plan("nested_loop")).map((t) => t.name)).toEqual(["i", "ii"]);
  });

  test("플랜의 단계와 테이블을 구분한다", () => {
    const named = (fixture: string) =>
      Object.fromEntries(collectPlanTables(plan(fixture)).map((t) => [t.name, t.synthetic]));

    // union 결과와 materialized 서브쿼리는 꺾쇠로 표기되지만, derived table은
    // 쿼리가 붙인 별칭을 그대로 쓴다. 옆에 있는 `materialized_from_subquery`가
    // 유일한 단서다.
    expect(named("union")).toEqual({ "<union1,2>": true, account: false });
    expect(named("subquery")).toEqual({ "<subquery2>": true, account: false });
    expect(named("derived")).toEqual({ d: true, account: false });
  });

  test("모르는 모양은 덜 찾을 뿐 터지지 않는다", () => {
    expect(collectPlanTables({ something: "else" })).toEqual([]);
    expect(collectPlanTables(null)).toEqual([]);
    // 테이블 노드는 두 필드가 다 있어야 한다. 하나만으로는 읽을 수 없다.
    expect(collectPlanTables({ table: { table_name: "account" } })).toEqual([]);
    expect(collectPlanTables({ table: { access_type: "ALL" } })).toEqual([]);
  });

  test("행 수 추정치가 어느 필드에서 왔는지 달고 온다", () => {
    const [outer, inner] = collectPlanTables(plan("nested_loop"));
    // 스캔당 3행인 `ref`는 3행짜리 일이 아니다. 위 단계가 48,872행을 내보낸다.
    // 이 한정어를 떼는 바람에 안쪽이 싸 보였다.
    expect(inner.rows).toEqual({ value: 3, unit: "rows/scan" });
    expect(outer.rows).toEqual({ value: 146632, unit: "rows/scan" });
  });

  test("추정치가 없는 노드는 없다고 보고한다", () => {
    const union = collectPlanTables(plan("union")).find((t) => t.name === "<union1,2>");
    expect(union?.rows).toBeNull();
  });
});

describe("parseExplainPayload", () => {
  const block = { query_block: { select_id: 1 } };

  test("mysql2가 돌려주는 모양이 무엇이든 EXPLAIN 컬럼 하나를 읽는다", () => {
    // 드라이버가 JSON 컬럼을 직접 파싱해 줄 때도 있고 문자열로 둘 때도 있으며,
    // 호출 방식에 따라 행을 배열로 감싸기도 한다.
    expect(parseExplainPayload([{ EXPLAIN: JSON.stringify(block) }])).toEqual(block);
    expect(parseExplainPayload([{ EXPLAIN: block }])).toEqual(block);
    expect(parseExplainPayload({ EXPLAIN: JSON.stringify(block) })).toEqual(block);
  });

  test("그 밖에는 터지지 않고 null을 준다", () => {
    expect(parseExplainPayload([{ EXPLAIN: "not json" }])).toBeNull();
    expect(parseExplainPayload([])).toBeNull();
    expect(parseExplainPayload(undefined)).toBeNull();
    expect(parseExplainPayload("bare string")).toBeNull();
  });
});

describe("renderTimeoutDiagnostic", () => {
  test("두 섹션이 테이블을 같은 이름으로 부른다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({
        plan: plan("alias"),
        qualifiers: { a: ACCOUNT, account: ACCOUNT },
        catalog: { account: facts("haulla", "account", [index("PRIMARY", "id")]) },
      }),
    );
    expect(section(report, "PLAN BY TABLE")).toContain("haulla.account (a)");
    expect(section(report, "INDEXES")).toContain("haulla.account:");
    // 별칭은 남긴다. 플랜의 조건식이 별칭으로 쓰여 있기 때문이다.
    expect(section(report, "PLAN BY TABLE")).toMatch(/`a`\.`createdAt`/);
  });

  test("별칭을 안 쓴 테이블에는 괄호가 붙지 않는다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({
        plan: plan("scan"),
        qualifiers: { account: ACCOUNT },
        catalog: { account: facts("haulla", "account", [index("PRIMARY", "id")]) },
      }),
    );
    expect(section(report, "PLAN BY TABLE")).toContain("1. haulla.account - access: ALL");
    expect(section(report, "PLAN BY TABLE")).not.toContain("(account)");
  });

  test("행 수에 스캔당이라는 단위가 붙는다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({ plan: plan("nested_loop"), qualifiers: { i: { schema: null, table: "invoice" } } }),
    );
    expect(section(report, "PLAN BY TABLE")).toContain("rows/scan: ~3");
    expect(section(report, "PLAN BY TABLE")).not.toMatch(/, rows: ~/);
  });

  test.each(["union", "subquery", "derived"])(
    "플랜의 단계는 요약에 남고 인덱스 목록에서 빠진다 (%s)",
    (fixture) => {
      const report = renderTimeoutDiagnostic(
        diagnosis({
          plan: plan(fixture),
          qualifiers: { account: ACCOUNT },
          catalog: { account: facts("haulla", "account", [index("PRIMARY", "id")]) },
        }),
      );
      const step = collectPlanTables(plan(fixture)).find((t) => t.synthetic)!.name;
      const entries = (block: string) =>
        block
          .split("\n")
          .slice(1)
          .map((line) => line.trim().split(":")[0]);
      expect(entries(section(report, "PLAN BY TABLE"))).toContainEqual(
        expect.stringContaining(step),
      );
      expect(entries(section(report, "INDEXES"))).not.toContain(step);
    },
  );

  test("derived table이 같은 이름의 실제 테이블 인덱스를 빌려 오지 않는다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({
        plan: plan("derived"),
        qualifiers: { account: ACCOUNT },
        catalog: {
          account: facts("haulla", "account", [index("PRIMARY", "id")]),
          // 진짜 `d` 테이블이 있다. `d`로 별칭 붙은 서브쿼리는 그것이 아니다.
          d: facts("haulla", "d", [index("IDX_route", "routeId", "day")]),
        },
      }),
    );
    expect(report).not.toContain("IDX_route");
  });

  test("카탈로그에 없는 테이블은 없다가 아니라 모른다로 적는다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({ plan: plan("scan"), qualifiers: { account: ACCOUNT }, catalog: {} }),
    );
    // "여기서는 인덱스 목록을 모른다"와 "인덱스가 없다"는 사용자에게 권할
    // 다음 행동이 다르다.
    expect(section(report, "INDEXES")).toContain("not in the local catalog");
    expect(section(report, "INDEXES")).toMatch(/unknown here/);
  });

  test("별칭이 몇 개든 테이블 하나에 한 줄이다", () => {
    const selfJoin = {
      query_block: {
        nested_loop: [
          { table: { table_name: "a", access_type: "ALL", rows_examined_per_scan: 10 } },
          { table: { table_name: "b", access_type: "ref", rows_examined_per_scan: 1 } },
        ],
      },
    };
    const report = renderTimeoutDiagnostic(
      diagnosis({
        plan: selfJoin,
        qualifiers: { a: ACCOUNT, b: ACCOUNT },
        catalog: { account: facts("haulla", "account", [index("PRIMARY", "id")]) },
      }),
    );
    expect(section(report, "PLAN BY TABLE")).toContain("haulla.account (a)");
    expect(section(report, "PLAN BY TABLE")).toContain("haulla.account (b)");
    expect(section(report, "INDEXES").match(/haulla\.account:/g)).toHaveLength(1);
  });

  test("이미 상한까지 쓴 쿼리에는 연장을 제안하지 않는다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({ plan: plan("scan"), timeoutSeconds: 30, maxTimeoutSeconds: 30 }),
    );
    // 이게 없으면 모델이 끝나지 않을 쿼리에 상한을 계속 올린다.
    expect(report).not.toContain("timeout_seconds: 30");
    expect(report).toContain("NOT available");
    expect(report).toContain("30s ceiling");
  });

  test("상한 아래인 쿼리에는 연장을 딱 한 번 제안한다", () => {
    const report = renderTimeoutDiagnostic(
      diagnosis({ plan: plan("scan"), timeoutSeconds: 10, maxTimeoutSeconds: 30 }),
    );
    expect(report).toContain("timeout_seconds: 30");
    expect(report).toContain("do not raise the limit further");
  });

  test("플랜이 없으면 그렇다고 말하고 선택지는 그대로 준다", () => {
    const report = renderTimeoutDiagnostic(diagnosis({ plan: null }));
    expect(report).toContain("[EXPLAIN UNAVAILABLE]");
    expect(report).not.toContain("[PLAN BY TABLE]");
    expect(report).toContain("Without a plan");
    expect(report).toContain("Do NOT run EXPLAIN yourself");
  });

  test("어떤 보고서든 같은 문장의 재실행을 금지한다", () => {
    for (const input of [diagnosis({ plan: plan("scan") }), diagnosis({ plan: null })]) {
      expect(renderTimeoutDiagnostic(input)).toMatch(/do NOT re-run this statement unchanged/i);
    }
  });

  test("너무 큰 플랜은 자르지 않고 통째로 뺀다", () => {
    const wide = {
      query_block: {
        nested_loop: Array.from({ length: 400 }, (_, i) => ({
          table: {
            table_name: `t${i}`,
            access_type: "ALL",
            rows_examined_per_scan: 1000,
            attached_condition: `(\`t${i}\`.\`col\` > 'a padded literal to make this plan wide')`,
          },
        })),
      },
    };
    const report = renderTimeoutDiagnostic(diagnosis({ plan: wide }));
    expect(report).toContain("[FULL PLAN] omitted");
    // 반쪽 JSON은 읽는 쪽이 추측해야 하는 물건이다.
    expect(report).not.toContain("[FULL PLAN]:");
    expect(section(report, "PLAN BY TABLE")).toContain("400. t399");
  });
});
