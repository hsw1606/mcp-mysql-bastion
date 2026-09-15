import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CatalogStore } from "../src/catalog/store.js";
import { CATALOG_VERSION, emptyTable, emptyUsage } from "../src/catalog/types.js";
import type { CatalogFile, CatalogOptions } from "../src/catalog/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const options = (): CatalogOptions => ({
  enabled: true,
  profile: "stage",
  fingerprint: "fp-1",
  filePath: join(dir, "catalog.json"),
  ttlHours: 24,
  appSchemas: [{ schema: "haulla", app: "haulla" }],
  docsRepo: null,
  docsRef: null,
  defaultSchema: "haulla",
});

/** 이전 빌드가 남겼을 법한 캐시 파일. */
function writeCache(overrides: Partial<CatalogFile>): void {
  const file: CatalogFile = {
    version: CATALOG_VERSION,
    profile: "stage",
    fingerprint: "fp-1",
    docs: { repo: null, ref: null, refCommit: null, refUpdatedAt: null, paths: [], unlinked: [] },
    schemas: {
      haulla: {
        app: "haulla",
        scannedAt: "2026-09-01T00:00:00.000Z",
        tables: {
          account: {
            ...emptyTable(),
            detailScannedAt: "2026-09-01T00:00:00.000Z",
            columns: [
              {
                name: "id",
                dataType: "int",
                columnType: "int",
                nullable: false,
                defaultValue: null,
                extra: "",
                comment: "",
                ordinal: 1,
              },
            ],
            usage: { ...emptyUsage(), successCount: 1 },
          },
        },
      },
    },
    joins: [],
    ...overrides,
  };
  writeFileSync(join(dir, "catalog.json"), JSON.stringify(file));
}

describe("다른 빌드가 남긴 캐시", () => {
  test("이 버전과 맞으면 읽는다", () => {
    writeCache({});
    expect(new CatalogStore(options()).readTable("haulla", "account")).not.toBeNull();
  });

  test("버전이 낮으면 버린다", () => {
    // 버전 1은 PII 컬럼 이름을 걸러내던 빌드가 썼다. 항목이 빠져 있는데 그
    // 사실을 기록하지 않아서, TTL에만 맡기면 하루 동안 짧은 컬럼 목록으로
    // 답한다.
    writeCache({ version: (CATALOG_VERSION - 1) as CatalogFile["version"] });
    expect(new CatalogStore(options()).readTable("haulla", "account")).toBeNull();
  });

  test("다른 profile의 것이면 버린다", () => {
    writeCache({ profile: "prod" });
    expect(new CatalogStore(options()).readTable("haulla", "account")).toBeNull();
  });

  test("설명하던 접속 대상이 바뀌었으면 버린다", () => {
    writeCache({ fingerprint: "fp-2" });
    expect(new CatalogStore(options()).readTable("haulla", "account")).toBeNull();
  });

  test("캐시가 아예 없는 것은 오류가 아니다", () => {
    const store = new CatalogStore(options());
    expect(store.isEnabled()).toBe(true);
    expect(store.readTable("haulla", "account")).toBeNull();
  });
});

describe("읽을 수 없는 캐시 파일", () => {
  /** 프로세스가 쓰다 죽었거나 사람이 손댄 파일. JSON으로 끝까지 읽히지 않는다. */
  function writeCorruptCache(): void {
    writeFileSync(join(dir, "catalog.json"), '{"version":2,"profile":"stage",');
  }

  test("카탈로그를 끄지 않는다", () => {
    // 깨진 파일은 복구 가능한 상황이다. 다음 flush의 원자적 rename이 그 파일을
    // 우리 내용으로 덮는다. 여기서 꺼 버리면 세션 내내 mysql_catalog가 죽는다.
    writeCorruptCache();
    expect(new CatalogStore(options()).isEnabled()).toBe(true);
  });

  test("캐시가 아예 없는 것과 같게 다룬다", () => {
    writeCorruptCache();
    const store = new CatalogStore(options());
    // 두 단언이 함께 있어야 한다. 꺼진 store도 readTable에 null을 주므로,
    // 아래 한 줄만 두면 카탈로그가 죽은 상태에서도 초록색으로 통과한다.
    expect(store.isEnabled()).toBe(true);
    expect(store.readTable("haulla", "account")).toBeNull();
  });

  test("왜 무시했는지 stderr에 남긴다", () => {
    // 조용히 넘어가면 운영자는 카탈로그가 매번 처음부터 시작하는 이유를 알 수
    // 없다. 끄지 않는 것과 아무 말도 하지 않는 것은 다르다.
    writeCorruptCache();
    new CatalogStore(options());
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "ignoring unreadable",
    );
  });

  test("다음 flush가 그 파일을 읽을 수 있는 내용으로 바꾼다", async () => {
    writeCorruptCache();
    const store = new CatalogStore(options());
    store.update((catalog) => {
      catalog.schemas.haulla.tables.account = emptyTable();
    });
    await store.close();

    const written = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    expect(written.fingerprint).toBe("fp-1");
    expect(Object.keys(written.schemas.haulla.tables)).toContain("account");
  });

  test("디스크를 쓸 수 없는 것은 여전히 카탈로그를 끈다", () => {
    // 경계선이 어디인지 고정한다. 관용하는 것은 파일 *내용*뿐이고, 디렉터리를
    // 만들 수조차 없는 경우는 다음 flush도 성공할 수 없으므로 끄는 쪽이 맞다.
    writeFileSync(join(dir, "blocked"), "not a directory");
    const store = new CatalogStore({
      ...options(),
      filePath: join(dir, "blocked", "catalog.json"),
    });
    expect(store.isEnabled()).toBe(false);
  });
});
