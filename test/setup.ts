import { fileURLToPath } from "node:url";

/**
 * src/config/index.ts는 import 시점에 dotenv로 env 파일을 읽는다. 그리고
 * dotenv는 읽은 값을 process.env에 직접 쓴다. `vi.unstubAllEnvs()`는 자기가
 * stub한 키만 되돌리므로, 한 번 실린 값은 같은 worker의 나머지 테스트에
 * 그대로 남는다.
 *
 * 그대로 두면 `MYSQL_PROFILE=prod`를 stub하는 경우가 개발자의 실제
 * `.env.prod`를 — MYSQL_PASS, MYSQL_HOST, ALLOW_* 까지 — 끌어온다. 그 파일이
 * 없는 CI에서는 또 다른 것을 검사하게 된다.
 *
 * `MYSQL_ENV_FILE`은 config가 보는 세 갈래 중 첫 번째이자, 나머지 둘을
 * 건너뛰게 하는 유일한 열쇠다. 빈 파일로 고정하면 profile 파일도 범용 .env도
 * 읽히지 않는다. MYSQL_PROFILE 자체는 그대로 stub되므로 프로필 판정을
 * 검사하는 경우는 하던 일을 계속한다.
 *
 * stubEnv가 아니라 직접 대입한다. 테스트가 부르는 unstubAllEnvs()가 이
 * 값까지 걷어가면 안 된다. 같은 이유로 setupFiles에 둔다 — 정적 import는
 * 테스트 파일 본문보다 먼저 평가되므로, 파일 안에서는 이미 늦다.
 */
process.env.MYSQL_ENV_FILE = fileURLToPath(
  new URL("fixtures/empty.env", import.meta.url),
);

/** 셸에 export돼 있으면 기본값을 검사하는 경우가 흔들린다. */
delete process.env.MYSQL_PROFILE;
