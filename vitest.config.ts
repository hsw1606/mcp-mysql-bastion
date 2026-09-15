import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/setup.ts가 왜 필요한지는 그 파일에 적혀 있다. 테스트 모듈 그래프가
    // 로드되기 전에 도는 자리는 여기뿐이다.
    setupFiles: ["./test/setup.ts"],
  },
});
