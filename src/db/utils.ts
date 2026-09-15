import { isMultiDbMode } from "./../config/index.js";
import { log } from "./../utils/index.js";
import SqlParser, { AST } from "node-sql-parser";

const { Parser } = SqlParser;
const parser = new Parser();

// 정확하게 뽑아내려고 AST 파서로 SQL 쿼리에서 스키마를 찾는다.
// 예전의 정규식 방식은 SQL 주석으로 우회할 수 있었고(예: USE/**/schema_name),
// 그러면 스키마 권한 검사가 전역 기본값으로 흘러가 버렸다.
function extractSchemaFromQuery(sql: string): string | null {
  // 환경 변수에 지정된 기본 스키마
  const defaultSchema = process.env.MYSQL_DB || null;

  // 기본 스키마가 있고 다중 DB 모드가 아니면 그대로 쓴다
  if (defaultSchema && !isMultiDbMode) {
    return defaultSchema;
  }

  // AST 파서로 스키마 정보를 믿을 만하게 뽑아낸다
  try {
    const astOrArray: AST | AST[] = parser.astify(sql, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

    for (const stmt of statements) {
      // 경우 1: USE database 문
      if (stmt.type === "use" && (stmt as any).db) {
        return (stmt as any).db;
      }

      // 경우 2: FROM/INTO 절의 database.table 표기
      const tables = (stmt as any).table || (stmt as any).from;
      if (Array.isArray(tables)) {
        for (const t of tables) {
          if (t.db) {
            return t.db;
          }
        }
      } else if (tables && typeof tables === "object" && tables.db) {
        return tables.db;
      }
    }
  } catch (err: any) {
    log("error", "Failed to parse SQL for schema extraction:", err.message);
  }

  // 쿼리에서 스키마를 찾지 못했으면 기본값을 돌려준다
  return defaultSchema;
}

/**
 * MySQL의 EXPLAIN은 EXPLAIN과 문장 사이에 수식어를 받을 수 있다:
 *   ANALYZE, EXTENDED, PARTITIONS, FORMAT=<word>
 *
 * node-sql-parser는 수식어 없는 `EXPLAIN <statement>`만 이해한다 — EXPLAIN 뒤에
 * 수식어가 붙으면 파싱이 깨진다. 그래서 파서에 넘기기 전에 떼어내, 예컨대
 * `EXPLAIN ANALYZE SELECT …`가 `EXPLAIN SELECT …`와 똑같이 처리되게 한다
 * (작업 유형은 `"explain"`, 읽기 전용으로 라우팅).
 *
 * 수식어는 `EXPLAIN ANALYZE FORMAT=JSON`처럼 여럿이 함께 올 수 있다.
 */
const EXPLAIN_MODIFIER_RE =
  /^(\s*EXPLAIN\s+)((?:ANALYZE\s+|EXTENDED\s+|PARTITIONS\s+|FORMAT\s*=\s*\w+\s+)+)/i;

function stripExplainModifiers(sql: string): string {
  return sql.replace(EXPLAIN_MODIFIER_RE, "$1");
}

async function getQueryTypes(query: string): Promise<string[]> {
  try {
    log("info", "Parsing SQL query: ", query);
    // node-sql-parser가 다루지 못하는 EXPLAIN 수식어(ANALYZE, FORMAT=…, EXTENDED,
    // PARTITIONS)를 파싱 전에 떼어낸다.
    const normalised = stripExplainModifiers(query);
    // AST 하나 또는 AST 배열로 파싱한다 — 데이터베이스 종류만 지정한다
    const astOrArray: AST | AST[] = parser.astify(normalised, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

    // 각 문장을 소문자 유형으로 바꾼다 (예: 'select', 'update', 'insert', 'delete' 등)
    return statements.map((stmt) => stmt.type?.toLowerCase() ?? "unknown");
  } catch (err: any) {
    log("error", "sqlParser error, query: ", query);
    log("error", "Error parsing SQL query:", err);
    throw new Error(`Parsing failed: ${err.message}`);
  }
}

/**
 * 스키마 introspection 문장의 분류. `null`이면 그런 문장이 아니다. SQL 파서가
 * 표현하지 못하는 문장을, 파스 오류로 거절해 버릴 블록 앞에서 따로 흘려보내는 데
 * 쓴다.
 */
export type IntrospectionKind =
  | "show_columns"
  | "show_create"
  | "show_index"
  // 스키마 구조만 드러내는 테이블/데이터베이스 수준의 메타데이터 목록
  // (테이블 이름, 데이터베이스 이름, 문자셋/콜레이션 목록). 컬럼 수준 정보가
  // 없으므로 실행기는 이 문장들을 손대지 않고 실행시킨다.
  | "show_passthrough"
  | "show_other"
  | "describe"
  | "information_schema"
  | "mysql_schema";

export interface IntrospectionResult {
  kind: IntrospectionKind | null;
}

// node-sql-parser가 파싱하지 못하지만 스키마는 그대로 흘리는 문장들(예:
// `SHOW FULL COLUMNS FROM users`, `SHOW FIELDS FROM users`). AST 순회로 넘어가기
// 전에 텍스트 검사로 먼저 걸러낸다.
const SHOW_INTROSPECTION_RE =
  /^\s*SHOW\s+(?:FULL\s+)?(COLUMNS|FIELDS|CREATE\s+TABLE|CREATE\s+VIEW|INDEX(?:ES)?|KEYS|TABLE\s+STATUS|TABLES|DATABASES|SCHEMAS|CHARACTER\s+SET|CHARSET|COLLATION)\b/i;
const DESCRIBE_RE = /^\s*(?:DESCRIBE|DESC)\s+/i;
// `EXPLAIN <table>`은 `DESCRIBE <table>`과 같은 말인데 파서가 이를 표현하지 못한다.
// 그래서 여기서 분류해 파싱을 건너뛰게 한다. 반대로 `EXPLAIN <select-stmt>` 같은
// 것은 매칭하면 안 된다. 그쪽은 파서가 처리하는 실행 계획 조회이고, 파싱을 건너뛰면
// 쓰기 라우팅까지 함께 빠진다. 부정 전방탐색에는 MySQL이 EXPLAIN 뒤에 받는 쿼리
// 문장 키워드를 나열해 뒀다.
const EXPLAIN_TABLE_RE =
  /^\s*EXPLAIN\s+(?!SELECT\b|INSERT\b|UPDATE\b|DELETE\b|REPLACE\b|ANALYZE\b|FORMAT\b|FOR\s|EXTENDED\b|PARTITIONS\b|\()[A-Za-z_`]/i;

/**
 * 스키마나 컬럼 메타데이터를 드러내는 쿼리를 골라낸다. 텍스트 사전 검사(파서가
 * 이해하지 못하는 `SHOW FULL COLUMNS FROM users` 같은 문장을 잡는다)와 AST
 * 순회(서브쿼리와 조인 안쪽까지 포함해, 쿼리 어디에서든 `information_schema`나
 * `mysql`을 가리키는 `db.table` 참조를 잡는다)를 함께 쓴다.
 *
 * 파싱이 실패했고 텍스트로도 걸리지 않으면 `{ kind: null }`을 돌려준다 — 그다음
 * 실행기가 평소대로 거절하거나 파스 오류를 그대로 드러낸다.
 */
function isIntrospectionQuery(sql: string): IntrospectionResult {
  const showMatch = sql.match(SHOW_INTROSPECTION_RE);
  if (showMatch) {
    const keyword = showMatch[1].toUpperCase().replace(/\s+/g, " ");
    if (keyword.startsWith("COLUMNS") || keyword.startsWith("FIELDS")) {
      return { kind: "show_columns" };
    }
    if (keyword.startsWith("CREATE")) {
      return { kind: "show_create" };
    }
    if (
      keyword.startsWith("INDEX") ||
      keyword.startsWith("KEYS")
    ) {
      return { kind: "show_index" };
    }
    // 테이블/데이터베이스 수준 목록: 스키마 구조뿐이고 컬럼 데이터는 없다.
    if (
      keyword === "TABLES" ||
      keyword.startsWith("TABLE STATUS") ||
      keyword === "DATABASES" ||
      keyword === "SCHEMAS" ||
      keyword.startsWith("CHARACTER") ||
      keyword === "CHARSET" ||
      keyword === "COLLATION"
    ) {
      return { kind: "show_passthrough" };
    }
    return { kind: "show_other" };
  }
  if (DESCRIBE_RE.test(sql) || EXPLAIN_TABLE_RE.test(sql)) {
    return { kind: "describe" };
  }

  let astOrArray: AST | AST[];
  try {
    astOrArray = parser.astify(sql, { database: "mysql" });
  } catch {
    return { kind: null };
  }
  const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];
  for (const stmt of statements) {
    const kind = findIntrospectionKind(stmt);
    if (kind) return { kind };
  }
  return { kind: null };
}

function findIntrospectionKind(node: unknown): IntrospectionKind | null {
  if (node == null || typeof node !== "object") return null;
  if (node instanceof Date) return null;

  const obj = node as Record<string, unknown>;

  if (obj.type === "show") {
    const keyword =
      typeof obj.keyword === "string" ? obj.keyword.toLowerCase() : "";
    if (keyword === "columns" || keyword === "fields") return "show_columns";
    if (keyword === "create") return "show_create";
    if (keyword === "index" || keyword === "keys") return "show_index";
    // 테이블/데이터베이스 수준 목록: 스키마 구조뿐이고 컬럼 데이터는 없다.
    // 실제로 확인해 보면 파싱되는 경우에 파서는 `keyword: "tables" / "databases" /
    // "character" / "collation"`을 내놓는다. SHOW TABLE STATUS, SHOW SCHEMAS,
    // SHOW CHARSET은 아예 파싱되지 않으며, 이들은 `isIntrospectionQuery` 앞쪽의
    // 텍스트 사전 검사가 맡는다.
    if (
      keyword === "tables" ||
      keyword === "databases" ||
      keyword === "character" ||
      keyword === "collation"
    ) {
      return "show_passthrough";
    }
    return "show_other";
  }
  if (obj.type === "desc" || obj.type === "describe") {
    return "describe";
  }

  // AST 어디에서든 메타데이터 스키마를 참조하는 경우(`from`, JOIN 대상, 서브쿼리
  // 등). AST는 이미 스키마 이름을 소문자로 담고 있지만, 파서 버전이 달라져도 통하도록
  // 한 번 더 소문자로 낮춘다.
  if (typeof obj.db === "string") {
    const db = obj.db.toLowerCase();
    if (db === "information_schema") return "information_schema";
    if (db === "mysql") return "mysql_schema";
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const kind = findIntrospectionKind(item);
        if (kind) return kind;
      }
    } else if (value && typeof value === "object") {
      const kind = findIntrospectionKind(value);
      if (kind) return kind;
    }
  }
  return null;
}

/** 테이블 한정자 -> 그것이 가리키는 테이블. 별칭과 맨 테이블 이름 모두 담는다. */
export type QualifierMap = Map<string, { schema: string | null; table: string }>;

function isRecord(node: unknown): node is Record<string, unknown> {
  return node != null && typeof node === "object" && !(node instanceof Date);
}

/**
 * 쿼리가 쓸 수 있는 모든 테이블 한정자를 — 별칭을 먼저, 테이블 이름을 대비책으로 —
 * 그것이 가리키는 테이블에 대응시킨다. `extractQueryConditions`가 쓰는 것과 같은
 * node-sql-parser의 `from` 항목으로 만들기 때문에, 둘은 `s.status`가 무엇을
 * 가리키는지 같게 본다.
 */
function extractQualifiers(sql: string): QualifierMap {
  const map: QualifierMap = new Map();
  let astOrArray: AST | AST[];
  try {
    astOrArray = parser.astify(stripExplainModifiers(sql), { database: "mysql" });
  } catch {
    return map;
  }
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (
      node.type !== "column_ref" &&
      typeof node.table === "string" &&
      (typeof node.db === "string" || node.db === null)
    ) {
      const reference = {
        schema: typeof node.db === "string" && node.db ? node.db : null,
        table: node.table,
      };
      map.set(node.table.toLowerCase(), reference);
      if (typeof node.as === "string" && node.as) {
        map.set(node.as.toLowerCase(), reference);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else visit(value);
    }
  };
  visit(astOrArray);
  return map;
}

export {
  extractSchemaFromQuery,
  getQueryTypes,
  isIntrospectionQuery,
  extractQualifiers,
  stripExplainModifiers,
};
