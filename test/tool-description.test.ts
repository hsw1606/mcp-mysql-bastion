import { describe, expect, test } from "vitest";
import { renderToolDescriptionSuffix } from "../src/catalog/render.js";
import { catalogWith } from "./helpers.js";

/** Claude Code가 도구 설명에 거는 상한. 단위는 문자다. */
const CLIENT_LIMIT = 2048;

const GUIDANCE = "mysql_catalog describe";

const busy = catalogWith(
  Array.from({ length: 12 }, (_, i) => ({
    schema: "haulla",
    table: `table_number_${i}`,
    successCount: 100 - i,
  })),
);

describe("renderToolDescriptionSuffix", () => {
  test("주어진 예산을 절대 넘지 않는다", () => {
    // 클라이언트는 꼬리부터 말없이 버린다. 그래서 안전하게 주장할 수 있는
    // 성질은 "어떤 예산도 넘지 않는다" 하나뿐이다. "보통은 들어간다"가 아니다.
    for (let budget = 0; budget <= 600; budget += 1) {
      expect(renderToolDescriptionSuffix(busy, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  test("바이트가 아니라 문자로 잰다", () => {
    // 안내문이 한국어라 UTF-8 크기가 길이를 한참 넘는다.
    const cold = catalogWith([{ schema: "haulla", table: "account", successCount: 0 }]);
    const instruction = renderToolDescriptionSuffix(cold, CLIENT_LIMIT);

    expect(Buffer.byteLength(instruction, "utf8")).toBeGreaterThan(instruction.length);
    // 자기 문자 길이만큼의 예산에는 들어가고, 하나라도 모자라면 안 들어간다.
    // 바이트로 쟀다면 이 예산을 그냥 거절한다.
    expect(renderToolDescriptionSuffix(cold, instruction.length)).toBe(instruction);
    expect(renderToolDescriptionSuffix(cold, instruction.length - 1)).toBe("");
  });

  test("지시문보다 테이블 이름을 먼저 버린다", () => {
    const wide = renderToolDescriptionSuffix(busy, 600);
    const narrow = renderToolDescriptionSuffix(busy, 200);
    const names = (s: string) => (s.match(/haulla\.table_number_\d+/g) ?? []).length;

    expect(names(wide)).toBeGreaterThan(names(narrow));
    // 하나는 지시이고 하나는 출발점 힌트다. 힌트는 `map`이 온전히 갖고 있다.
    expect(wide).toContain(GUIDANCE);
    expect(narrow).toContain(GUIDANCE);
  });

  test("아래가 빈 머리말을 남기느니 지시문만 남긴다", () => {
    const guidanceOnly = renderToolDescriptionSuffix(busy, 80);
    expect(guidanceOnly).toContain(GUIDANCE);
    expect(guidanceOnly).not.toContain("CATALOG HOT TABLES");
  });

  test("지시문조차 안 들어가면 아무것도 내지 않는다", () => {
    expect(renderToolDescriptionSuffix(busy, 10)).toBe("");
    expect(renderToolDescriptionSuffix(busy, 0)).toBe("");
    // 음수 예산은 base가 이미 상한을 넘었을 때 들어온다.
    expect(renderToolDescriptionSuffix(busy, -500)).toBe("");
  });

  test("많이 읽은 순으로, 이름만 적는다", () => {
    const suffix = renderToolDescriptionSuffix(busy, CLIENT_LIMIT);
    const listed = suffix.match(/haulla\.table_number_\d+/g) ?? [];
    expect(listed.slice(0, 3)).toEqual([
      "haulla.table_number_0",
      "haulla.table_number_1",
      "haulla.table_number_2",
    ]);
    // 이름 뒤에 붙던 조회 횟수와 날짜는 목록의 순위를 설명한 것인데,
    // 목록이 이미 그 순서다.
    expect(suffix).not.toMatch(/\d+ reads/);
  });

  test("아무도 읽지 않은 테이블은 출발점으로 내놓지 않는다", () => {
    const unread = catalogWith([
      { schema: "haulla", table: "huge_event_log", successCount: 0 },
      { schema: "haulla", table: "account", successCount: 3 },
    ]);
    const suffix = renderToolDescriptionSuffix(unread, CLIENT_LIMIT);
    expect(suffix).toContain("haulla.account");
    expect(suffix).not.toContain("huge_event_log");
  });

  test("아직 아무것도 안 읽은 카탈로그도 지시문은 싣는다", () => {
    const cold = catalogWith([{ schema: "haulla", table: "account", successCount: 0 }]);
    const suffix = renderToolDescriptionSuffix(cold, CLIENT_LIMIT);
    expect(suffix).toContain(GUIDANCE);
    expect(suffix).not.toContain("CATALOG HOT TABLES");
  });
});
