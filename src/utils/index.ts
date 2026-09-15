import { SchemaPermissions } from "../types/index.js";
type LogType = "info" | "error";

// @INFO: ENABLE_LOGGING이 true면 로깅을 켠다
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

// MySQL 접속 설정 타입
export interface MySQLConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  socketPath?: string;
}

// MySQL 접속 문자열(mysql CLI 형식)을 파싱하는 함수
// 예: mysql --default-auth=mysql_native_password -A -hrdsproxy.staging.luno.com -P3306 -uUSER -pPASS database_name
export function parseMySQLConnectionString(
  connectionString: string,
): MySQLConnectionConfig {
  const config: MySQLConnectionConfig = {};

  // 맨 앞에 'mysql' 명령이 있으면 지운다
  let cleanedString = connectionString.trim().replace(/^mysql\s+/, '');

  // 플래그와 옵션을 파싱한다
  const tokens = [];
  let currentToken = '';
  let inQuotes = false;
  let quoteChar: string | null = null;

  for (let i = 0; i < cleanedString.length; i++) {
    const char = cleanedString[i];

    if ((char === '"' || char === "'") && (!inQuotes || char === quoteChar)) {
      // 따옴표 문자는 넣지 않고 인용 상태만 뒤집는다
      inQuotes = !inQuotes;
      quoteChar = inQuotes ? char : null;
    } else if (char === ' ' && !inQuotes) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = '';
      }
    } else {
      currentToken += char;
    }
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  // 토큰을 처리한다
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // 값이 붙은 짧은 옵션인지 확인한다 (예: -uUSER, -pPASS, -hHOST, -PPORT)
    if (token.startsWith('-') && !token.startsWith('--')) {
      const flag = token[1];
      let value = token.substring(2);

      // 값이 붙어 있지 않으면 다음 토큰을 본다
      if (!value && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        value = tokens[i + 1];
        i++;
      }

      switch (flag) {
        case 'h':
          config.host = value;
          break;
        case 'P': {
          const port = parseInt(value, 10);
          if (Number.isNaN(port) || !Number.isFinite(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${value}`);
          }
          config.port = port;
          break;
        }
        case 'u':
          config.user = value;
          break;
        case 'p':
          config.password = value;
          break;
        case 'S':
          config.socketPath = value;
          break;
      }
    }
    // 긴 옵션인지 확인한다 (예: --host=HOST, --port=PORT)
    else if (token.startsWith('--')) {
      const [flag, ...valueParts] = token.substring(2).split('=');
      let value = valueParts.join('=');

      // =로 값을 주지 않았으면 다음 토큰을 본다
      if (!value && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        value = tokens[i + 1];
        i++;
      }

      switch (flag) {
        case 'host':
          config.host = value;
          break;
        case 'port': {
          const port = parseInt(value, 10);
          if (Number.isNaN(port) || !Number.isFinite(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${value}`);
          }
          config.port = port;
          break;
        }
        case 'user':
          config.user = value;
          break;
        case 'password':
          config.password = value;
          break;
        case 'socket':
          config.socketPath = value;
          break;
      }
    }
    // -로 시작하지 않는 마지막 위치 인자가 데이터베이스 이름이다
    else if (!token.startsWith('-')) {
      // 플래그의 일부가 아니고 뒤쪽 인자일 때만 데이터베이스로 본다
      config.database = token;
    }
  }

  return config;
}
