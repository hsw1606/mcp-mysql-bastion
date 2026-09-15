import * as fs from "fs";
import * as net from "net";
import { Client as SSHClient, type ConnectConfig } from "ssh2";
import { log } from "../utils/index.js";
import { expandHome, readSSHConfigHost } from "./config.js";

/**
 * 완전히 해석된 SSH 터널 설정. `resolveTunnelConfig()`가 환경 변수에서 만들며,
 * 필요하면 `~/.ssh/config`의 alias 값으로 빈 자리를 채운다.
 */
export interface TunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKeyPath: string;
  passphrase?: string;
  /** 요청한 로컬 포트. 0은 "비어 있는 포트를 OS가 고르게 한다"는 뜻이다. */
  localPort: number;
  /** bastion이 우리 대신 접속할 주소. */
  remoteHost: string;
  remotePort: number;
}

/** 터널이 열린 뒤 MySQL 풀이 바라볼 주소. */
export interface TunnelEndpoint {
  host: string;
  port: number;
  /** 새로 열지 않고 이미 떠 있던 listener에 붙었으면 true. */
  reused: boolean;
}

/**
 * probe와 `listen()` 사이에 다른 프로세스가 로컬 포트를 가져갔을 때 던진다.
 * 그 자체로 실패는 아니다. 호출자는 OS가 골라 준 포트로 물러나 자기 터널을
 * 연다. 남의 터널을 빌리지 않는다 - 빌린 터널은 그것을 연 프로세스가 끝나는
 * 순간 같이 죽는다.
 */
class LocalPortTakenError extends Error {}

const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const PROBE_TIMEOUT_MS = 750;
const SSH_READY_TIMEOUT_MS = 20000;

// FIXME: AGENTS.md는 환경 변수를 src/config/index.ts에서만 읽으라고 못박는데,
// 이 모듈은 MYSQL_SSH_* 를 직접 읽는다 — SSH_ENABLED, SSH_REUSE_EXISTING,
// 그리고 아래 optionalEnv()를 거치는 나머지 전부. config로 옮기고 여기서는
// 상수를 import한다.
export const SSH_ENABLED = process.env.MYSQL_SSH_ENABLED === "true";

/**
 * 우리 터널을 새로 열지 않고, 프로필의 로컬 포트에서 이미 listen 중인 forward에
 * 붙는다.
 *
 * 기본값은 꺼짐이고, 이는 의도한 선택이다. 재사용하면 이 프로세스의 DB 접속이
 * 터널을 연 다른 프로세스의 수명에 묶인다. MCP 클라이언트는 서버를 수시로 켜고
 * 끄므로 터널 주인이 먼저 종료되는 일이 잦고, 그때 빌려 쓰던 쪽의 커넥션은 쿼리
 * 도중 PROTOCOL_CONNECTION_LOST로 끊긴다. 우리 터널을 직접 소유하면 SSH 세션
 * 하나를 더 쓰는 대신 이 실패 유형이 통째로 사라진다.
 *
 * 외부에서 관리하는 forward(오래 떠 있는 `ssh -L`)를 공유할 의도가 있을 때만 켠다.
 */
export const SSH_REUSE_EXISTING =
  process.env.MYSQL_SSH_REUSE_EXISTING === "true";

// 카탈로그 식별자와 터널 생성은 같은 원격 대상을 가리켜야 한다.
// 프로세스 내내 바뀌지 않는 설정을 캐시해 두면, 두 단계 사이에 SSH config를
// 고치더라도 캐시가 다른 DB를 가리키는 일이 생기지 않는다.
let resolvedTunnelConfig: TunnelConfig | null = null;

function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `${label} must be an integer between 0 and 65535, got "${raw}".`,
    );
  }
  return port;
}

/**
 * 환경 변수의 SSH 터널 설정과 선택적인 `~/.ssh/config` alias를 합친다.
 *
 * 우선순위는 명시적으로 준 환경 변수가 항상 위다. alias는 환경 변수가 비워 둔
 * 자리만 채운다. 그래야 운영자가 기존 alias를 그대로 쓰면서도, SSH config는
 * 건드리지 않고 프로필 하나의 로컬 포트만 따로 덮어쓸 수 있다.
 *
 * `MYSQL_HOST` / `MYSQL_PORT`는 forwarding 대상의 기본값 역할을 한다. 터널을 쓰는
 * 구성에서 이 값이 *bastion에서 본* DB 주소이기 때문이다.
 */
export function resolveTunnelConfig(): TunnelConfig {
  if (resolvedTunnelConfig) return resolvedTunnelConfig;
  const configHost = optionalEnv("MYSQL_SSH_CONFIG_HOST");

  let fromConfig: ReturnType<typeof readSSHConfigHost> = null;
  if (configHost) {
    fromConfig = readSSHConfigHost(configHost);
    if (!fromConfig) {
      throw new Error(
        `MYSQL_SSH_CONFIG_HOST="${configHost}" was not found as a Host alias in ~/.ssh/config. ` +
          `Either add the alias or set MYSQL_SSH_HOST / MYSQL_SSH_USER explicitly.`,
      );
    }
    log(
      "info",
      `[ssh] resolved alias "${configHost}" from ~/.ssh/config: ` +
        JSON.stringify({
          hostName: fromConfig.hostName,
          user: fromConfig.user,
          port: fromConfig.port,
          localForward: fromConfig.localForward,
        }),
    );
  }

  const sshHost = optionalEnv("MYSQL_SSH_HOST") ?? fromConfig?.hostName;
  const sshUser = optionalEnv("MYSQL_SSH_USER") ?? fromConfig?.user;
  const sshPort =
    parsePort(optionalEnv("MYSQL_SSH_PORT"), "MYSQL_SSH_PORT") ??
    fromConfig?.port ??
    22;

  const privateKeyPath = expandHome(
    optionalEnv("MYSQL_SSH_PRIVATE_KEY_PATH") ??
      fromConfig?.identityFile ??
      "~/.ssh/id_rsa",
  );

  // 로컬 포트: 환경 변수, 없으면 alias의 LocalForward, 그래도 없으면 0(자동).
  const localPort =
    parsePort(optionalEnv("MYSQL_SSH_LOCAL_PORT"), "MYSQL_SSH_LOCAL_PORT") ??
    fromConfig?.localForward?.localPort ??
    0;

  // forwarding 대상: alias의 LocalForward가 가장 구체적인 정보다.
  // 없으면 프로필의 MySQL host/port로 물러난다.
  const remoteHost =
    fromConfig?.localForward?.remoteHost ?? optionalEnv("MYSQL_HOST");
  const remotePort =
    fromConfig?.localForward?.remotePort ??
    parsePort(optionalEnv("MYSQL_PORT"), "MYSQL_PORT") ??
    3306;

  const missing: string[] = [];
  if (!sshHost) missing.push("MYSQL_SSH_HOST (or a HostName in the alias)");
  if (!sshUser) missing.push("MYSQL_SSH_USER (or a User in the alias)");
  if (!remoteHost) {
    missing.push("MYSQL_HOST (or a LocalForward target in the alias)");
  }
  if (missing.length > 0) {
    throw new Error(
      `MYSQL_SSH_ENABLED=true but the tunnel is underspecified. Missing: ${missing.join(", ")}.`,
    );
  }

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(
      `SSH private key not found at "${privateKeyPath}". ` +
        `Set MYSQL_SSH_PRIVATE_KEY_PATH to the key that authenticates ${sshUser}@${sshHost}.`,
    );
  }

  resolvedTunnelConfig = {
    sshHost: sshHost!,
    sshPort,
    sshUser: sshUser!,
    privateKeyPath,
    passphrase: optionalEnv("MYSQL_SSH_PASSPHRASE"),
    localPort,
    remoteHost: remoteHost!,
    remotePort,
  };
  return resolvedTunnelConfig;
}

/**
 * 127.0.0.1:port에서 이미 접속을 받고 있는가?
 *
 * "중복해서 열지 말고 이미 있는 터널을 재사용한다"를 지키려고 쓴다. 다른
 * 프로세스를 들여다볼 수 있는 신호는 TCP handshake 성공뿐이므로, 그것을 이
 * 프로필의 forward가 이미 떠 있다는 증거로 삼는다. 다른 터미널에서 손으로 띄운
 * `ssh -L`도 여기 포함되며, 그게 의도한 동작이다.
 */
function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

/** 모듈 수준의 터널 상태. 설계상 서버 프로세스마다 터널은 하나다. */
let endpointPromise: Promise<TunnelEndpoint | null> | null = null;
let localServer: net.Server | null = null;
let sshClient: SSHClient | null = null;
let activeConfig: TunnelConfig | null = null;
let shuttingDown = false;
/** 재연결 시도를 모두 소진했을 때 채워지며, 호출자에게 그대로 전달된다. */
let fatalError: Error | null = null;

function connectSSH(cfg: TunnelConfig): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(
        new Error(
          `SSH handshake with ${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort} did not complete within ${SSH_READY_TIMEOUT_MS}ms.`,
        ),
      );
    }, SSH_READY_TIMEOUT_MS);

    client.once("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    });

    client.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(
        new Error(
          `SSH connection to ${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort} failed: ${err.message}`,
        ),
      );
    });

    let privateKey: Buffer;
    try {
      privateKey = fs.readFileSync(cfg.privateKeyPath);
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      reject(
        new Error(
          `Failed to read SSH private key "${cfg.privateKeyPath}": ${(err as Error).message}`,
        ),
      );
      return;
    }

    const connectConfig: ConnectConfig = {
      host: cfg.sshHost,
      port: cfg.sshPort,
      username: cfg.sshUser,
      privateKey,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      ...(cfg.passphrase ? { passphrase: cfg.passphrase } : {}),
    };

    client.connect(connectConfig);
  });
}

/**
 * 예기치 않게 끊긴 SSH 전송을 다시 세운다. 로컬 listener는 그대로 두므로 MySQL
 * 풀이 바라보는 주소도 바뀌지 않는다.
 *
 * RECONNECT_MAX_ATTEMPTS 번까지 지수 백오프로 재시도한다. 끝내 실패하면 프로세스를
 * 끝내는 대신 `fatalError`에 기록한다. 이 프로세스는 오래 떠 있는 MCP 서버이고,
 * 조용히 사라지는 것보다 다음 쿼리에서 분명한 에러를 주는 편이 클라이언트에게 낫다.
 */
async function reconnect(cfg: TunnelConfig): Promise<void> {
  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    if (shuttingDown) return;
    const delay = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
    log(
      "error",
      `[ssh] tunnel dropped; reconnect attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (shuttingDown) return;
    try {
      const client = await connectSSH(cfg);
      sshClient = client;
      fatalError = null;
      attachDropHandler(client, cfg);
      log("error", `[ssh] tunnel reconnected on attempt ${attempt}`);
      return;
    } catch (err) {
      log("error", `[ssh] reconnect attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }

  fatalError = new Error(
    `SSH tunnel to ${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort} could not be re-established after ${RECONNECT_MAX_ATTEMPTS} attempts. ` +
      `Restart the MCP server once the bastion is reachable again.`,
  );
  log("error", `[ssh] ${fatalError.message}`);
}

let reconnecting = false;

function attachDropHandler(client: SSHClient, cfg: TunnelConfig): void {
  const onDrop = () => {
    if (shuttingDown || reconnecting) return;
    if (sshClient !== client) return; // 더 새로운 client로 교체됨
    sshClient = null;
    reconnecting = true;
    void reconnect(cfg).finally(() => {
      reconnecting = false;
    });
  };
  client.once("close", onDrop);
  client.once("error", (err: Error) => {
    log("error", `[ssh] transport error: ${err.message}`);
    onDrop();
  });
}

/**
 * 터널 앞단이 되는 로컬 listener를 연다. 받아들인 소켓마다 공유 SSH 연결 위에
 * 자기 `forwardOut` 채널을 얻는다. 그래서 mysql2 풀은 SSH 세션 하나 위에 서로
 * 독립적인 MySQL 커넥션 여러 개를 갖게 된다.
 */
function startLocalServer(
  cfg: TunnelConfig,
  requestedPort: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const client = sshClient;
      if (!client) {
        socket.destroy(
          fatalError ??
            new Error("SSH tunnel is not currently connected; retry shortly."),
        );
        return;
      }
      client.forwardOut(
        "127.0.0.1",
        0,
        cfg.remoteHost,
        cfg.remotePort,
        (err, stream) => {
          if (err) {
            log(
              "error",
              `[ssh] forwardOut to ${cfg.remoteHost}:${cfg.remotePort} failed: ${err.message}`,
            );
            socket.destroy(err);
            return;
          }
          socket.pipe(stream).pipe(socket);
          const cleanup = () => {
            stream.destroy();
            socket.destroy();
          };
          socket.once("error", cleanup);
          stream.once("error", cleanup);
          socket.once("close", () => stream.destroy());
          stream.once("close", () => socket.destroy());
        },
      );
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new LocalPortTakenError(
            `Local port ${requestedPort} was claimed by another process.`,
          ),
        );
        return;
      }
      reject(
        new Error(
          `Failed to open local tunnel listener on port ${requestedPort}: ${err.message}`,
        ),
      );
    });

    // loopback에만 bind한다. 이 포트는 forwarding된 DB에 인증 없이 닿게 해 주므로
    // 네트워크에서 접근할 수 있으면 안 된다.
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local tunnel listener reported no TCP address."));
        return;
      }
      localServer = server;
      resolve(address.port);
    });
  });
}

/**
 * SSH 터널이 떠 있도록 보장하고, MySQL 풀이 쓸 주소를 돌려준다.
 *
 * `MYSQL_SSH_ENABLED`가 `true`가 아니면 null을 준다. 호출자는 "터널 없음"을 평범한
 * 직접 연결로 다루면 된다. 멱등하다. 첫 호출이 이기고 이후 호출은 모두 같은 결과를
 * 기다리므로, 한 프로세스에서 터널이 두 번 열리지 않는다.
 *
 * promise는 로컬 포트가 실제로 listen을 시작한 뒤에야 resolve된다. 그래서 이를
 * await한 호출자는 곧바로 커넥션 풀을 만들어도 된다.
 */
export function ensureTunnel(): Promise<TunnelEndpoint | null> {
  if (!SSH_ENABLED) return Promise.resolve(null);

  if (!endpointPromise) {
    endpointPromise = (async (): Promise<TunnelEndpoint> => {
      const cfg = resolveTunnelConfig();
      activeConfig = cfg;

      // 명시적으로 켰을 때만: 다른 쪽이 띄워 둔 forward에 붙는다.
      // 왜 이것이 기본값이 아닌지는 SSH_REUSE_EXISTING 주석을 보라.
      if (
        SSH_REUSE_EXISTING &&
        cfg.localPort !== 0 &&
        (await probeLocalPort(cfg.localPort))
      ) {
        log(
          "error",
          `[ssh] 127.0.0.1:${cfg.localPort} is already accepting connections; reusing it (MYSQL_SSH_REUSE_EXISTING=true).`,
        );
        return { host: "127.0.0.1", port: cfg.localPort, reused: true };
      }

      log(
        "error",
        `[ssh] opening tunnel ${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort} -> ${cfg.remoteHost}:${cfg.remotePort} ` +
          `(local port ${cfg.localPort === 0 ? "auto" : cfg.localPort})`,
      );

      const client = await connectSSH(cfg);
      sshClient = client;

      let port: number;
      try {
        port = await startLocalServer(cfg, cfg.localPort);
      } catch (err) {
        if (!(err instanceof LocalPortTakenError)) {
          client.destroy();
          sshClient = null;
          throw err;
        }

        // 프로필이 원하는 포트를 누군가 이미 쓰고 있다. 이 서버의 다른 인스턴스일
        // 수도, 손으로 띄운 forward일 수도 있다. 언제 종료될지 모르는 그 터널을
        // 빌리거나 그냥 실패하는 대신, OS가 골라 준 포트로 물러나 우리 터널을
        // 유지한다. 풀에는 접속할 주소를 알려 주므로 포트 번호 자체는 이후 동작에
        // 아무 영향이 없다.
        log(
          "error",
          `[ssh] local port ${cfg.localPort} is taken; opening our own tunnel on an auto-assigned port instead.`,
        );
        try {
          port = await startLocalServer(cfg, 0);
        } catch (fallbackErr) {
          client.destroy();
          sshClient = null;
          throw fallbackErr;
        }
      }

      attachDropHandler(client, cfg);
      log("error", `[ssh] tunnel listening on 127.0.0.1:${port}`);
      return { host: "127.0.0.1", port, reused: false };
    })();

    // 실패한 시도는 캐시하면 안 된다. 다음 호출이 자유롭게 재시도할 수 있어야 한다
    // (예를 들어 운영자가 bastion을 다시 살린 뒤).
    endpointPromise.catch(() => {
      endpointPromise = null;
      activeConfig = null;
    });
  }

  return endpointPromise;
}

/** 재연결을 포기하면서 기록한 에러. 없으면 null. */
export function getTunnelFatalError(): Error | null {
  return fatalError;
}

/** 시작 로그와 도구 응답에 쓸, 사람이 읽기 좋은 요약. */
export function describeTunnel(): string | null {
  if (!SSH_ENABLED) return null;
  if (!activeConfig) return "ssh tunnel: enabled (not yet established)";
  const { sshUser, sshHost, remoteHost, remotePort } = activeConfig;
  return `ssh tunnel: ${sshUser}@${sshHost} -> ${remoteHost}:${remotePort}`;
}

/**
 * 터널을 닫는다. 여러 번 불러도, 터널을 한 번도 연 적이 없어도 안전하다.
 * 그래서 종료 경로마다 따로 방어할 필요가 없다.
 */
export async function stopTunnel(): Promise<void> {
  shuttingDown = true;

  const server = localServer;
  localServer = null;
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 끊지 않는 클라이언트가 붙들고 있는 소켓은 close()를 멈춰 세운다.
      // 종료가 무한정 늘어지지 않도록 그런 소켓은 버린다.
      server.unref();
      setTimeout(resolve, 1000);
    });
  }

  const client = sshClient;
  sshClient = null;
  if (client) {
    try {
      client.end();
      client.destroy();
    } catch (err) {
      log("error", `[ssh] error closing SSH client: ${(err as Error).message}`);
    }
  }

  endpointPromise = null;
  activeConfig = null;
  shuttingDown = false;
}
