import { describe, expect, test } from "vitest";
import {
  extractQualifiers,
  getQueryTypes,
  isIntrospectionQuery,
  stripExplainModifiers,
} from "../src/db/utils.js";

/**
 * `executeReadOnlyQuery`가 `isUnparseableIntrospection`으로 세우는 규칙.
 *
 * AST를 걸어서 찾아낸 kind는 파서가 그 문장을 처리했다는 뜻이다. 그러니
 * 쿼리 타입 검사와 권한 검사를 계속 거쳐야 한다. 우회시키면 쓰기 라우팅까지
 * 건너뛴다.
 */
const bypassesParser = (sql: string): boolean => {
  const kind = isIntrospectionQuery(sql).kind;
  return kind !== null && kind !== "information_schema" && kind !== "mysql_schema";
};

describe("isIntrospectionQuery", () => {
  test.each([
    ["SHOW COLUMNS FROM account", "show_columns"],
    ["SHOW FULL COLUMNS FROM account", "show_columns"],
    ["SHOW FIELDS FROM account", "show_columns"],
    ["SHOW CREATE TABLE account", "show_create"],
    ["SHOW INDEX FROM account", "show_index"],
    ["SHOW KEYS FROM account", "show_index"],
    ["SHOW TABLES", "show_passthrough"],
    ["SHOW DATABASES", "show_passthrough"],
    ["SHOW TABLE STATUS", "show_passthrough"],
    ["SHOW COLLATION", "show_passthrough"],
    ["DESCRIBE account", "describe"],
    ["DESC account", "describe"],
    ["EXPLAIN account", "describe"],
  ])("%s 를 %s 로 분류한다", (sql, kind) => {
    expect(isIntrospectionQuery(sql).kind).toBe(kind);
  });

  test("파서가 처리하는 문장은 introspection이 아니다", () => {
    expect(isIntrospectionQuery("SELECT id FROM account").kind).toBeNull();
  });

  describe("파서 우회", () => {
    test("파서가 모델링하지 못하는 문장을 덮는다", () => {
      // 이것들은 `astify`에서 그대로 실패한다. 우회가 없으면 실행되는 대신
      // 파스 에러로 거절된다.
      expect(bypassesParser("SHOW FULL COLUMNS FROM account")).toBe(true);
      expect(bypassesParser("SHOW TABLE STATUS")).toBe(true);
      expect(bypassesParser("DESCRIBE account")).toBe(true);
    });

    test("mysql 스키마를 겨냥한 쓰기는 덮지 않는다", () => {
      // 분류가 틀리면 읽기 전용 서버에서 쓰기가 나가는, 단 하나의 경우다.
      expect(isIntrospectionQuery("UPDATE mysql.user SET x = 1").kind).toBe("mysql_schema");
      expect(bypassesParser("UPDATE mysql.user SET x = 1")).toBe(false);
      expect(bypassesParser("DELETE FROM mysql.user")).toBe(false);
    });

    test("information_schema 조회는 덮지 않는다", () => {
      const sql = "SELECT table_name FROM information_schema.tables";
      expect(isIntrospectionQuery(sql).kind).toBe("information_schema");
      expect(bypassesParser(sql)).toBe(false);
    });

    test("문장을 대상으로 한 EXPLAIN은 덮지 않는다", () => {
      // `EXPLAIN <테이블>`은 DESCRIBE라서 우회해야 하지만,
      // `EXPLAIN <문장>`은 파서가 처리하는 플랜 조회다. 우회시키면 그 문장이
      // 쓰기 라우팅을 지나쳐 간다.
      //
      // `describe`가 아니라는 것만으로는 부족하다. 우회 조건은
      // `information_schema`와 `mysql_schema`를 뺀 모든 kind이므로, 회귀가
      // 이 문장들을 다른 아무 kind로나 분류해도 쓰기는 그대로 나간다.
      for (const sql of [
        "EXPLAIN SELECT id FROM account",
        "EXPLAIN ANALYZE SELECT id FROM account",
        "EXPLAIN FORMAT=JSON SELECT id FROM account",
        "EXPLAIN UPDATE account SET id = 1",
        "EXPLAIN (SELECT 1)",
      ]) {
        expect(isIntrospectionQuery(sql).kind).not.toBe("describe");
        expect(bypassesParser(sql)).toBe(false);
      }
    });
  });
});

describe("stripExplainModifiers", () => {
  test("node-sql-parser가 못 받는 것만 떼어낸다", () => {
    expect(stripExplainModifiers("EXPLAIN FORMAT=JSON SELECT 1")).toBe("EXPLAIN SELECT 1");
    expect(stripExplainModifiers("EXPLAIN ANALYZE FORMAT=JSON SELECT 1")).toBe("EXPLAIN SELECT 1");
    expect(stripExplainModifiers("EXPLAIN SELECT 1")).toBe("EXPLAIN SELECT 1");
    expect(stripExplainModifiers("SELECT 1")).toBe("SELECT 1");
  });

  test("떼어낸 문장이 원래 타입으로 파싱된다", async () => {
    await expect(getQueryTypes("EXPLAIN FORMAT=JSON SELECT 1")).resolves.toContain("explain");
  });
});

describe("extractQualifiers", () => {
  test("별칭이 그것이 가리키는 테이블로 풀린다", () => {
    const map = extractQualifiers("SELECT a.id FROM account a WHERE a.id > 1");
    expect(map.get("a")).toEqual({ schema: null, table: "account" });
    // 테이블 이름 자체도 키로 들어간다. 플랜이 별칭을 안 쓴 경우를 위해서다.
    expect(map.get("account")).toEqual({ schema: null, table: "account" });
  });

  test("쿼리가 스키마를 적었으면 그것도 담는다", () => {
    const map = extractQualifiers("SELECT i.id FROM haulla.invoice i");
    expect(map.get("i")).toEqual({ schema: "haulla", table: "invoice" });
  });

  test("조인에 나오는 테이블을 모두 담는다", () => {
    const map = extractQualifiers(
      "SELECT i.id FROM invoice i JOIN invoice_item ii ON ii.invoiceId = i.id",
    );
    expect(map.get("i")?.table).toBe("invoice");
    expect(map.get("ii")?.table).toBe("invoice_item");
  });

  test("서브쿼리 안까지 들어간다", () => {
    const map = extractQualifiers(
      "SELECT id FROM account WHERE status IN (SELECT status FROM contract c)",
    );
    expect(map.get("c")).toEqual({ schema: null, table: "contract" });
  });

  test("파싱 안 되는 문장은 터지지 않고 빈 결과를 준다", () => {
    expect(extractQualifiers("SHOW FULL COLUMNS FROM account").size).toBe(0);
    expect(extractQualifiers("!!! not sql !!!").size).toBe(0);
  });
});
