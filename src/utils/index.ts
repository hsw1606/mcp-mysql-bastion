import { SchemaPermissions } from "../types/index.js";
type LogType = "info" | "error";

// @INFO: ENABLE_LOGGING이 true면 로깅을 켠다
// FIXME: AGENTS.md대로라면 이 값도 src/config/index.ts가 읽어 export해야 한다.
// 옮기기 전에 순환 import를 먼저 풀어야 한다 — config가 이 파일의
// parseSchemaPermissions를 import하고 있다.
const ENABLE_LOGGING =
  process.env.ENABLE_LOGGING === "true" || process.env.ENABLE_LOGGING === "1";

/**
 * 진단용 로깅. 언제나 stderr로 보내고 stdout은 쓰지 않는다.
 *
 * 서버가 stdio 전송으로 돌 때 stdout에는 MCP 프로토콜 프레이밍이 흐른다.
 * `console.info`와 `console.log`는 둘 다 stdout에 쓰므로, 로그 한 줄만 섞여도
 * 스트림이 깨지고 클라이언트 handshake가 JSON 파싱 에러로 실패한다. 모든 레벨을
 * `console.error`로 보내면 어떤 MCP 클라이언트에서도 `ENABLE_LOGGING=true`를
 * 안심하고 켤 수 있다.
 */
export function log(type: LogType = "info", ...args: any[]): void {
  if (!ENABLE_LOGGING) return;

  const prefix = type === "error" ? "[error]" : "[info]";
  console.error(prefix, ...args);
}

// 환경 변수에서 스키마별 권한을 파싱하는 함수
export function parseSchemaPermissions(
  permissionsString?: string,
): SchemaPermissions {
  const permissions: SchemaPermissions = {};

  if (!permissionsString) {
    return permissions;
  }

  // 형식: "schema1:true,schema2:false"
  const permissionPairs = permissionsString.split(",");

  for (const pair of permissionPairs) {
    const [schema, value] = pair.split(":");
    if (schema && value) {
      permissions[schema.trim()] = value.trim() === "true";
    }
  }

  return permissions;
}
