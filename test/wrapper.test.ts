import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

/**
 * `bin/_mcp-mysql-run.sh`의 사전 확인이 서버보다 엄격해지지 않는지 검사한다.
 *
 * wrapper는 한때 키 파일을 `MYSQL_SSH_PRIVATE_KEY_PATH`와 `~/.ssh/id_rsa`로만
 * 확인했다. 서버는 그 사이에 alias의 IdentityFile을 보므로, README가 권하는
 * 설정(alias에 IdentityFile을 적는 것)이 node가 뜨기도 전에 거절됐다.
 *
 * 실제 서버 대신 "started"만 찍는 stub을 `dist/index.js` 자리에 둔다. wrapper가
 * exec까지 갔는지만 보면 되고, 서버를 띄우면 터널을 열려고 한다. HOME도 빈
 * 임시 디렉터리로 바꿔 개발자의 `~/.ssh`가 결과를 흔들지 않게 한다.
 */
const wrapper = fileURLToPath(new URL("../bin/_mcp-mysql-run.sh", import.meta.url));

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function run(envFile: string) {
  root = mkdtempSync(join(tmpdir(), "mcp-mysql-wrapper-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "dist"));
  copyFileSync(wrapper, join(root, "bin", "_mcp-mysql-run.sh"));
  writeFileSync(join(root, "dist", "index.js"), 'process.stderr.write("started\\n");\n');
  writeFileSync(join(root, ".env.stage"), envFile);

  return spawnSync("bash", [join(root, "bin", "_mcp-mysql-run.sh"), "stage"], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
}

describe("wrapper 사전 확인", () => {
  test("alias를 쓰면 ~/.ssh/id_rsa가 없어도 서버를 띄운다", () => {
    const result = run(
      [
        "MYSQL_SSH_ENABLED=true",
        "MYSQL_SSH_CONFIG_HOST=stage-db",
        "MYSQL_USER=reader",
        "MYSQL_PASS=secret",
      ].join("\n"),
    );

    expect(result.stderr).toBe("started\n");
    expect(result.status).toBe(0);
  });

  test("alias 없이 host와 user가 빠지면 서버를 띄우기 전에 멈춘다", () => {
    const result = run(
      ["MYSQL_SSH_ENABLED=true", "MYSQL_USER=reader", "MYSQL_PASS=secret"].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MYSQL_SSH_HOST MYSQL_SSH_USER");
    expect(result.stderr).not.toContain("started");
  });
});
