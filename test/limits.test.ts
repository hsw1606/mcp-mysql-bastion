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
