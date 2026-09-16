import { ENABLE_LOGGING } from "../config/index.js";

type LogType = "info" | "error";

/**
 * 진단용 로깅. 언제나 stderr로 보내고 stdout은 쓰지 않는다.
 *
 * 서버가 stdio 전송으로 돌 때 stdout에는 MCP 프로토콜 프레이밍이 흐른다.
 * `console.info`와 `console.log`는 둘 다 stdout에 쓰므로, 로그 한 줄만 섞여도
 * 스트림이 깨지고 클라이언트 handshake가 JSON 파싱 에러로 실패한다. 모든 레벨을
 * `console.error`로 보내면 어떤 MCP 클라이언트에서도 `ENABLE_LOGGING=true`를
 * 안심하고 켤 수 있다.
 *
 * 스위치는 `src/config/index.ts`에서 받는다. 예전에는 이 파일이 직접
 * `process.env.ENABLE_LOGGING`을 읽었는데, 그러면 config가 이 파일의
 * `parseSchemaPermissions`를 import하던 것과 맞물려 순환이 됐다. 그 함수를
 * config로 옮겨 순환을 끊었다.
 */
export function log(type: LogType = "info", ...args: any[]): void {
  if (!ENABLE_LOGGING) return;

  const prefix = type === "error" ? "[error]" : "[info]";
  console.error(prefix, ...args);
}
