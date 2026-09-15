import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
