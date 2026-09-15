import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 이 서버가 `Host` alias 하나에서 이해하는 `~/.ssh/config` 지시어들. 블록 안의
 * 나머지는 무시한다. 범용 OpenSSH config 구현을 만들 생각은 없고, 운영자가 이미
 * 손으로 써 둔 alias를 재사용할 만큼만 읽는다.
 */
export interface SSHConfigHostEntry {
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** 블록 안의 첫 번째 `LocalForward`. 없으면 비워 둔다. */
  localForward?: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
  };
}

/** 앞에 붙은 `~`를 펼치고, 상대 경로는 $HOME 기준으로 푼다. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * OpenSSH config 한 줄을 (keyword, value)로 나눈다. OpenSSH는 `Keyword value`와
 * `Keyword=value`를 모두 받고, keyword는 대소문자를 가리지 않는다.
 * 빈 줄과 주석 줄에는 null을 준다.
 */
function splitDirective(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  const ws = trimmed.search(/\s/);

  // 먼저 나오는 구분자를 쓴다. `=`는 값 안에 정상적으로 들어갈 수 있으므로
  // (예: ProxyCommand), 공백보다 앞설 때만 구분자로 본다.
  let sepIndex: number;
  if (eq !== -1 && (ws === -1 || eq < ws)) {
    sepIndex = eq;
  } else if (ws !== -1) {
    sepIndex = ws;
  } else {
    return null; // 값이 없는 keyword
  }

  const keyword = trimmed.slice(0, sepIndex).trim().toLowerCase();
  const value = trimmed
    .slice(sepIndex + 1)
    .trim()
    .replace(/^=/, "")
    .trim();
  if (!keyword || !value) return null;
  return [keyword, value];
}

/**
 * `LocalForward` 값을 파싱한다. OpenSSH는 여러 형태를 허용한다.
 *   LocalForward 3307 db.internal:3306
 *   LocalForward 127.0.0.1:3307 db.internal:3306
 *   LocalForward 3307 db.internal 3306      (드물게, 공백으로 구분)
 * 확실하게 읽지 못한 값에는 null을 준다. 어설프게 해석한 forward보다 환경 변수로
 * 물러나는 편이 낫다.
 */
function parseLocalForward(
  value: string,
): SSHConfigHostEntry["localForward"] | null {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  // 로컬 쪽: "port" 아니면 "bind:port".
  const localRaw = parts[0];
  const localPortStr = localRaw.includes(":")
    ? localRaw.slice(localRaw.lastIndexOf(":") + 1)
    : localRaw;
  const localPort = Number(localPortStr);
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    return null;
  }

  // 원격 쪽: "host:port", 또는 "host" 다음에 포트가 별도 토큰으로 온다.
  let remoteHost: string;
  let remotePortStr: string;
  const remoteRaw = parts[1];
  const lastColon = remoteRaw.lastIndexOf(":");
  if (lastColon > 0) {
    remoteHost = remoteRaw.slice(0, lastColon);
    remotePortStr = remoteRaw.slice(lastColon + 1);
  } else if (parts.length >= 3) {
    remoteHost = remoteRaw;
    remotePortStr = parts[2];
  } else {
    return null;
  }

  const remotePort = Number(remotePortStr);
  if (!remoteHost || !Number.isInteger(remotePort) || remotePort <= 0) {
    return null;
  }

  return { localPort, remoteHost, remotePort };
}

/**
 * OpenSSH config 파일에서 `Host` alias 하나를 찾는다.
 *
 * `Host` 줄의 토큰과 정확히(대소문자만 무시하고) 비교하는 것은 의도한 선택이다.
 * `MYSQL_SSH_CONFIG_HOST`는 운영자가 이미 써 둔 alias를 가리키려는 것이지,
 * OpenSSH의 wildcard와 `Match` 규칙을 다시 구현하려는 것이 아니다. 그래서
 * `Host *` 같은 wildcard 블록은 아무것도 보태지 않고, 해석 결과는 예측 가능해진다.
 *
 * 파일이나 alias가 없으면 null을 준다.
 */
export function readSSHConfigHost(
  alias: string,
  configPath: string = path.join(os.homedir(), ".ssh", "config"),
): SSHConfigHostEntry | null {
  if (!fs.existsSync(configPath)) return null;

  const wanted = alias.trim().toLowerCase();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read SSH config at ${configPath}: ${(err as Error).message}`,
    );
  }

  let inBlock = false;
  const entry: SSHConfigHostEntry = {};
  let found = false;

  for (const line of raw.split(/\r?\n/)) {
    const directive = splitDirective(line);
    if (!directive) continue;
    const [keyword, value] = directive;

    if (keyword === "host") {
      // 새 Host 줄은 언제나 앞 블록을 끝낸다.
      inBlock = value
        .split(/\s+/)
        .some((token) => token.toLowerCase() === wanted);
      if (inBlock) found = true;
      continue;
    }

    // `Match` 블록은 우리가 평가하지 않는 조건을 쓴다. 그 안의 지시어를 조용히
    // 흡수하는 대신, 현재 Host 블록이 끝난 것으로 본다.
    if (keyword === "match") {
      inBlock = false;
      continue;
    }

    if (!inBlock) continue;

    switch (keyword) {
      case "hostname":
        entry.hostName ??= value;
        break;
      case "user":
        entry.user ??= value;
        break;
      case "port": {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          entry.port ??= port;
        }
        break;
      }
      case "identityfile":
        // OpenSSH는 IdentityFile을 여러 줄 허용한다. 여기서는 첫 줄이 이긴다.
        entry.identityFile ??= expandHome(value.replace(/^"|"$/g, ""));
        break;
      case "localforward": {
        const forward = parseLocalForward(value);
        if (forward && !entry.localForward) entry.localForward = forward;
        break;
      }
      default:
        break;
    }
  }

  return found ? entry : null;
}
