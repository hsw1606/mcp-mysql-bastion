import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

/**
 * "환경 변수는 `src/config/index.ts`에서만 읽는다"를 소스로 검사한다.
 *
 * 이 규칙은 리뷰로만 지켜지다가 네 파일에서 조용히 깨져 있었다. 그중 둘은 같은
 * 값을 서로 다른 기본값으로 읽고 있었다 — 진단 로그가 실제 접속과 다른 주소를
 * 말했다. 사람이 아니라 테스트가 지키게 한다.
 *
 * 주석은 세지 않는다. 왜 이 자리에서 `process.env`를 읽지 않는지 적어 둔 주석이
 * 여럿이고, 그것까지 위반으로 치면 근거를 남길 자리가 없어진다.
 *
 * 그 판정을 손으로 하지 않고 `typescript`에 맡긴다. 처음에는 줄마다 `//` 뒤를
 * 잘라내는 방식이었는데, 문자열 리터럴 안의 `//`도 주석으로 쳤다 —
 * `"mysql://" + process.env.MYSQL_HOST`가 통째로 빠져나갔다. 막으려던 회귀가
 * 들어와도 통과하는 검사였다. 주석과 문자열의 경계를 다시 구현하는 대신 AST를
 * 본다. 주석은 AST에 없고, 문자열 안의 글자는 노드가 되지 않는다.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 환경 변수를 읽는 유일한 자리. */
const CONFIG = "src/config/index.ts";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** 주석 밖에서 `process.env`를 읽는 줄 번호. */
function envReadLines(source: string): number[] {
  const parsed = ts.createSourceFile(
    "scanned.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const hits: number[] = [];

  // `process.env.X`와 `process.env["X"]` 둘 다 같은 `process.env` 노드를 지난다.
  // 구조분해(`const { env } = process`)는 잡지 못하지만, 이 저장소에 그렇게 쓴
  // 자리가 없고 잡으려면 심볼 해석이 필요하다. 필요해지면 그때 넓힌다.
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "env" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    ) {
      const { line } = parsed.getLineAndCharacterOfPosition(
        node.getStart(parsed),
      );
      hits.push(line + 1);
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return hits;
}

describe("환경 변수를 읽는 자리", () => {
  test(`${CONFIG} 말고는 아무도 process.env를 읽지 않는다`, () => {
    const files = [`${repoRoot}index.ts`, ...sourceFiles(`${repoRoot}src`)];
    const offenders: string[] = [];

    for (const file of files) {
      const relative = file.slice(repoRoot.length);
      if (relative === CONFIG) continue;
      const lines = envReadLines(readFileSync(file, "utf8"));
      for (const line of lines) offenders.push(`${relative}:${line}`);
    }

    expect(offenders).toEqual([]);
  });

  test("주석 안의 process.env는 위반으로 세지 않는다", () => {
    // 위 검사가 주석을 세지 않는다는 것 자체를 고정한다. 이게 깨지면 위 검사는
    // 근거 주석을 다는 순간 실패하는, 아무도 지킬 수 없는 규칙이 된다.
    expect(envReadLines("// process.env.FOO\n")).toEqual([]);
    expect(envReadLines("/**\n * process.env.FOO\n */\n")).toEqual([]);
    expect(envReadLines("/*\nprocess.env.FOO\n*/\n")).toEqual([]);
    expect(envReadLines("const a = process.env.FOO;\n")).toEqual([1]);
    expect(envReadLines("const a = process.env.FOO; // 설명\n")).toEqual([1]);
  });

  test("문자열 안의 //가 뒤따르는 process.env를 가리지 않는다", () => {
    // 줄마다 첫 "//" 뒤를 잘라내던 시절에는 이 두 줄이 통째로 주석으로 취급돼
    // 빈 배열이 나왔다. 접속 문자열을 다루는 저장소라 실제로 쓰일 형태다.
    expect(envReadLines('const u = "mysql://" + process.env.MYSQL_HOST;\n')).toEqual([1]);
    expect(envReadLines("const u = `mysql://${process.env.MYSQL_HOST}`;\n")).toEqual([1]);
    // 반대로 문자열 안에 적힌 process.env는 읽는 것이 아니다.
    expect(envReadLines('const doc = "process.env.FOO를 쓰지 마라";\n')).toEqual([]);
  });
});
