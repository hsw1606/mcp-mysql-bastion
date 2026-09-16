import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  const hits: number[] = [];
  let inBlockComment = false;

  source.split("\n").forEach((line, i) => {
    let code = line;
    if (inBlockComment) {
      const end = code.indexOf("*/");
      if (end === -1) return;
      code = code.slice(end + 2);
      inBlockComment = false;
    }
    // JSDoc 본문 줄. 블록 상태를 놓쳐도 이 한 줄로 걸러진다.
    if (code.trimStart().startsWith("*")) return;
    // 한 줄 안에서 열고 닫는 블록 주석을 먼저 지운다.
    code = code.replace(/\/\*.*?\*\//g, "");
    const open = code.indexOf("/*");
    if (open !== -1) {
      inBlockComment = true;
      code = code.slice(0, open);
    }
    const lineComment = code.indexOf("//");
    if (lineComment !== -1) code = code.slice(0, lineComment);

    if (code.includes("process.env")) hits.push(i + 1);
  });

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
    expect(envReadLines(" * process.env.FOO\n")).toEqual([]);
    expect(envReadLines("/*\nprocess.env.FOO\n*/\n")).toEqual([]);
    expect(envReadLines("const a = process.env.FOO;\n")).toEqual([1]);
    expect(envReadLines("const a = process.env.FOO; // 설명\n")).toEqual([1]);
  });
});
