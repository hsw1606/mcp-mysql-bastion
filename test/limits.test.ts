import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * config는 import 시점에 환경변수를 한 번 읽는다. 아래 각 경우는 자기가 다루는
 * 환경으로 config를 다시 import하므로, 사이사이 모듈 캐시를 비워야 한다.
 */
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const clamp = async () => (await import("../src/db/index.js")).clampTimeoutSeconds;
const config = async () => await import("../src/config/index.js");

describe("clampTimeoutSeconds", () => {
  test("거절하지 않고 양쪽으로 클램프한다", async () => {
    const clampTimeoutSeconds = await clamp();
    // 스키마에 maximum 30이 선언돼 있지만 클라이언트가 100을 그대로 넘기는
    // 것이 관측됐다. 실제 방어선은 여기다.
    expect(clampTimeoutSeconds(100)).toBe(30);
    expect(clampTimeoutSeconds(0)).toBe(1);
    expect(clampTimeoutSeconds(-5)).toBe(1);
    expect(clampTimeoutSeconds(30)).toBe(30);
  });

  test("초 단위로 버린다", async () => {
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds(9.9)).toBe(9);
  });

  test("숫자가 아닌 값은 기본값으로 떨어진다", async () => {
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds(undefined)).toBe(10);
    expect(clampTimeoutSeconds(Number.NaN)).toBe(10);
    expect(clampTimeoutSeconds(Number.POSITIVE_INFINITY)).toBe(10);
  });

  test("정수로 읽히는 문자열은 같은 값의 숫자와 똑같이 다룬다", async () => {
    // maximum 30을 어기고 100을 보내는 그 클라이언트가 integer를 어기고 "30"을
    // 보낸다. 문자열을 버리면 timeout을 올려 재시도하라는 안내가 무효가 된다.
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds("30")).toBe(30);
    expect(clampTimeoutSeconds(" 30 ")).toBe(30);
  });

  test("문자열도 숫자와 같은 규칙으로 버리고 클램프한다", async () => {
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds("9.9")).toBe(9);
    expect(clampTimeoutSeconds("100")).toBe(30);
    expect(clampTimeoutSeconds("0")).toBe(1);
    expect(clampTimeoutSeconds("-5")).toBe(1);
  });

  test("빈 문자열은 1초 요청이 아니라 기본값이다", async () => {
    // Number("")도 Number("   ")도 0이다. 그대로 클램프하면 1초가 되는데,
    // 아무것도 적지 않은 것을 가장 짧은 실행을 요청한 것으로 읽는 셈이다.
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds("")).toBe(10);
    expect(clampTimeoutSeconds("   ")).toBe(10);
  });

  test("읽을 수 없는 값은 거절하지 않고 기본값으로 떨어진다", async () => {
    // Number(null)은 0, Number(true)는 1, Number([])도 0이다. 타입을 먼저
    // 가르지 않으면 이 값들이 전부 짧은 timeout 요청으로 둔갑한다.
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds("abc")).toBe(10);
    expect(clampTimeoutSeconds(null)).toBe(10);
    expect(clampTimeoutSeconds(true)).toBe(10);
    expect(clampTimeoutSeconds({})).toBe(10);
    expect(clampTimeoutSeconds([])).toBe(10);
  });

  test("상한을 기본값 아래로 내리면 기본값도 같이 내려간다", async () => {
    // 아니면 어떤 호출도 요청할 수 없는 기본값이 남는다.
    vi.stubEnv("MYSQL_MAX_TIMEOUT_SECONDS", "5");
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds(undefined)).toBe(5);
    expect(clampTimeoutSeconds(100)).toBe(5);
  });

  test("상한을 올려도 기본값은 오르지 않는다", async () => {
    vi.stubEnv("MYSQL_MAX_TIMEOUT_SECONDS", "60");
    const clampTimeoutSeconds = await clamp();
    expect(clampTimeoutSeconds(undefined)).toBe(10);
    expect(clampTimeoutSeconds(100)).toBe(60);
  });
});

describe("운영자 상한", () => {
  test("셋 다 기본값이 있어서 기존 profile을 고칠 필요가 없다", async () => {
    const c = await config();
    expect(c.MYSQL_MAX_TIMEOUT_SECONDS).toBe(30);
    expect(c.MYSQL_CATALOG_TIMEOUT_SECONDS).toBe(60);
    expect(c.MAX_RESPONSE_ROWS).toBe(5000);
  });

  test("못 쓸 값은 적용되는 대신 기본값으로 떨어지고 그 사실을 알린다", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MYSQL_MAX_RESPONSE_ROWS", "0");
    expect((await config()).MAX_RESPONSE_ROWS).toBe(5000);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("MYSQL_MAX_RESPONSE_ROWS"));
  });

  test("카탈로그의 시간 상한은 호출자의 것과 별개다", async () => {
    // 사용자 쿼리는 대화형이라 빨리 실패해야 하고, 인벤토리 스캔은 선언된
    // 스키마를 한꺼번에 훑는 일이라 더 기다릴 값이 있다.
    vi.stubEnv("MYSQL_MAX_TIMEOUT_SECONDS", "15");
    const c = await config();
    expect(c.MYSQL_MAX_TIMEOUT_SECONDS).toBe(15);
    expect(c.MYSQL_CATALOG_TIMEOUT_SECONDS).toBe(60);
  });
});

describe("숫자 환경 변수", () => {
  test("못 쓸 MYSQL_PORT는 NaN이 되는 대신 기본값으로 떨어진다", async () => {
    // 상한 값들과 달리 여기만 맨 Number()를 썼던 탓에 NaN이 그대로 mysql2까지
    // 갔다. 그러면 접속은 실패하는데 무엇이 잘못됐는지는 아무도 말해주지 않는다.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    // 셸에 socket path가 export돼 있으면 풀 옵션이 host/port 자리를 통째로
    // 비운다. 그러면 이 검사는 개발자 환경에 따라 undefined를 본다.
    vi.stubEnv("MYSQL_SOCKET_PATH", "");
    vi.stubEnv("MYSQL_PORT", "three");
    const c = await config();
    expect(c.MYSQL_PORT).toBe(3306);
    expect((c.mcpConfig.mysql as { port: number }).port).toBe(3306);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("MYSQL_PORT"));
  });

  test("범위 밖 MYSQL_PORT도 기본값으로 떨어진다", async () => {
    // 범위 검사는 원래 src/ssh/tunnel.ts의 parsePort가 하고 있었다. 그 함수를
    // config로 합치면서 MYSQL_PORT만 parsePositiveInt로 읽어 상한을 잃었고,
    // 70000이 아무 말 없이 mysql2와 터널의 remotePort까지 흘러갔다.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MYSQL_SOCKET_PATH", "");
    vi.stubEnv("MYSQL_PORT", "70000");
    const c = await config();
    expect(c.MYSQL_PORT).toBe(3306);
    expect((c.mcpConfig.mysql as { port: number }).port).toBe(3306);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("MYSQL_PORT"));
  });

  test("못 쓸 SSH 포트는 서버를 죽이지 않고 물러난다", async () => {
    // 예전에는 같은 MYSQL_PORT를 두고 두 정책이 공존했다. config는 3306으로
    // 물러나며 알렸고, 터널 경로는 던져서 프로세스를 끝냈다. 터널을 쓰는
    // 프로필에서는 알림 쪽이 닿지도 못했다.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MYSQL_SSH_PORT", "twenty-two");
    vi.stubEnv("MYSQL_SSH_LOCAL_PORT", "70000");
    const c = await config();
    expect(c.SSH_PORT).toBeUndefined();
    expect(c.SSH_LOCAL_PORT).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("MYSQL_SSH_PORT"));
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("MYSQL_SSH_LOCAL_PORT"),
    );
  });

  test("0은 SSH 로컬 포트에서 유효한 값이다", async () => {
    // README가 "0은 자동 할당"이라고 약속한다. parsePositiveInt로 읽으면
    // 그 약속이 경고와 함께 사라진다.
    vi.stubEnv("MYSQL_SSH_LOCAL_PORT", "0");
    expect((await config()).SSH_LOCAL_PORT).toBe(0);
  });
});

describe("기본 스키마", () => {
  test("공백만 든 MYSQL_DB는 없는 것으로 본다", async () => {
    // 예전에는 isMultiDbMode만 trim하고 풀 옵션의 database는 원문을 썼다.
    // 서버는 다중 DB 모드라고 말하면서 mysql2에는 이름이 " "인 스키마를 넘겼다.
    vi.stubEnv("MYSQL_DB", "   ");
    const c = await config();
    expect(c.MYSQL_DB).toBeUndefined();
    expect(c.isMultiDbMode).toBe(true);
    expect(c.mcpConfig.mysql.database).toBeUndefined();
  });
});

describe("쓰기가 금지된 profile", () => {
  test("플래그가 뭐라고 하든 모든 쓰기를 거절한다", async () => {
    vi.stubEnv("MYSQL_PROFILE", "prod");
    vi.stubEnv("ALLOW_INSERT_OPERATION", "true");
    vi.stubEnv("ALLOW_UPDATE_OPERATION", "true");
    vi.stubEnv("ALLOW_DELETE_OPERATION", "true");
    vi.stubEnv("ALLOW_DDL_OPERATION", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const c = await config();
    expect(c.IS_WRITE_FORBIDDEN_PROFILE).toBe(true);
    expect([
      c.ALLOW_INSERT_OPERATION,
      c.ALLOW_UPDATE_OPERATION,
      c.ALLOW_DELETE_OPERATION,
      c.ALLOW_DDL_OPERATION,
    ]).toEqual([false, false, false, false]);
  });

  test("스키마별 override도 함께 비운다", async () => {
    // `SCHEMA_UPDATE_PERMISSIONS=foo:true` 하나면 profile이 닫은 문이 다시
    // 열린다.
    vi.stubEnv("MYSQL_PROFILE", "prod");
    vi.stubEnv("SCHEMA_UPDATE_PERMISSIONS", "haulla:true");
    vi.stubEnv("SCHEMA_DELETE_PERMISSIONS", "haulla:true");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const c = await config();
    expect(c.SCHEMA_UPDATE_PERMISSIONS).toEqual({});
    expect(c.SCHEMA_DELETE_PERMISSIONS).toEqual({});

    const permissions = await import("../src/db/permissions.js");
    expect(permissions.isUpdateAllowedForSchema("haulla")).toBe(false);
    expect(permissions.isDeleteAllowedForSchema(null)).toBe(false);
  });

  test("stage profile은 운영자가 설정한 값을 그대로 둔다", async () => {
    vi.stubEnv("MYSQL_PROFILE", "stage");
    vi.stubEnv("ALLOW_UPDATE_OPERATION", "true");
    const c = await config();
    expect(c.IS_WRITE_FORBIDDEN_PROFILE).toBe(false);
    expect(c.ALLOW_UPDATE_OPERATION).toBe(true);
  });
});
