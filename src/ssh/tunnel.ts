import * as fs from "fs";
import * as net from "net";
import { Client as SSHClient, type ConnectConfig } from "ssh2";
import { log } from "../utils/index.js";
import { expandHome, readSSHConfigHost } from "./config.js";

/**
 * Fully resolved SSH tunnel parameters. Produced by `resolveTunnelConfig()`
 * from environment variables, optionally seeded from a `~/.ssh/config` alias.
 */
export interface TunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKeyPath: string;
  passphrase?: string;
  /** Requested local port; 0 means "let the OS pick a free one". */
  localPort: number;
  /** Address the bastion should connect to on our behalf. */
  remoteHost: string;
  remotePort: number;
}

/** Where the MySQL pool should point once the tunnel is up. */
export interface TunnelEndpoint {
  host: string;
  port: number;
  /** True when we attached to a pre-existing listener instead of opening one. */
  reused: boolean;
}

const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const PROBE_TIMEOUT_MS = 750;
const SSH_READY_TIMEOUT_MS = 20000;

export const SSH_ENABLED = process.env.MYSQL_SSH_ENABLED === "true";

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
 * Merge SSH tunnel settings from the environment with an optional
 * `~/.ssh/config` alias.
 *
 * Precedence: explicit environment variables always win. The config alias only
 * fills in what the environment left blank — that way an operator can point at
 * an existing alias and still override, say, the local port for one profile
 * without editing their SSH config.
 *
 * `MYSQL_HOST` / `MYSQL_PORT` act as the fallback forwarding target, since in a
 * tunnelled setup those name the database as seen *from the bastion*.
 */
export function resolveTunnelConfig(): TunnelConfig {
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

  // Local port: explicit env, else the alias's LocalForward, else 0 (auto).
  const localPort =
    parsePort(optionalEnv("MYSQL_SSH_LOCAL_PORT"), "MYSQL_SSH_LOCAL_PORT") ??
    fromConfig?.localForward?.localPort ??
    0;

  // Forwarding target: the alias's LocalForward is the most specific signal;
  // otherwise fall back to the MySQL host/port from the profile.
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

  return {
    sshHost: sshHost!,
    sshPort,
    sshUser: sshUser!,
    privateKeyPath,
    passphrase: optionalEnv("MYSQL_SSH_PASSPHRASE"),
    localPort,
    remoteHost: remoteHost!,
    remotePort,
  };
}

/**
 * Is something already accepting connections on 127.0.0.1:port?
 *
 * Used to honour "reuse an existing tunnel rather than opening a duplicate".
 * A successful TCP handshake is the only cross-process signal available to us,
 * so we treat it as proof that a forward for this profile is already running —
 * a manual `ssh -L` in another terminal counts, which is the intent.
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

/** Module-level tunnel state. One tunnel per server process, by design. */
let endpointPromise: Promise<TunnelEndpoint | null> | null = null;
let localServer: net.Server | null = null;
let sshClient: SSHClient | null = null;
let activeConfig: TunnelConfig | null = null;
let shuttingDown = false;
/** Set when reconnection has exhausted its attempts; surfaced to callers. */
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
 * Re-establish the SSH transport after an unexpected drop, keeping the local
 * listener (and therefore the MySQL pool's target address) intact.
 *
 * Backs off exponentially for up to RECONNECT_MAX_ATTEMPTS tries. On final
 * failure we record `fatalError` instead of exiting: the process is a long-lived
 * MCP server, and a clear error on the next query is more useful to the client
 * than a silent disappearance.
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
    if (sshClient !== client) return; // superseded by a newer client
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
 * Open the local listener that fronts the tunnel. Each accepted socket gets its
 * own `forwardOut` channel on the shared SSH connection, which is how mysql2's
 * pool ends up with several independent MySQL connections over one SSH session.
 */
function startLocalServer(cfg: TunnelConfig): Promise<number> {
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
          new Error(
            `Local port ${cfg.localPort} is already in use by a process that did not accept our probe. ` +
              `Free the port, or set MYSQL_SSH_LOCAL_PORT=0 to auto-assign one.`,
          ),
        );
        return;
      }
      reject(
        new Error(
          `Failed to open local tunnel listener on port ${cfg.localPort}: ${err.message}`,
        ),
      );
    });

    // Bind to loopback only — this port grants unauthenticated access to the
    // forwarded database and must never be reachable from the network.
    server.listen(cfg.localPort, "127.0.0.1", () => {
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
 * Ensure an SSH tunnel is up, returning the address the MySQL pool should use.
 *
 * Returns null when `MYSQL_SSH_ENABLED` is not `true`, so callers can treat
 * "no tunnel" as an ordinary direct connection. Idempotent: the first call wins
 * and every later call awaits the same result, which is what prevents a second
 * tunnel from being opened for the same process.
 *
 * The promise resolves only once the local port is actually listening, so a
 * caller that awaits it can create the connection pool immediately afterwards.
 */
export function ensureTunnel(): Promise<TunnelEndpoint | null> {
  if (!SSH_ENABLED) return Promise.resolve(null);

  if (!endpointPromise) {
    endpointPromise = (async (): Promise<TunnelEndpoint> => {
      const cfg = resolveTunnelConfig();
      activeConfig = cfg;

      // Reuse an existing forward on this port rather than duplicating it.
      if (cfg.localPort !== 0 && (await probeLocalPort(cfg.localPort))) {
        log(
          "error",
          `[ssh] 127.0.0.1:${cfg.localPort} is already accepting connections; reusing the existing tunnel.`,
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
        port = await startLocalServer(cfg);
      } catch (err) {
        client.destroy();
        sshClient = null;
        throw err;
      }

      attachDropHandler(client, cfg);
      log("error", `[ssh] tunnel listening on 127.0.0.1:${port}`);
      return { host: "127.0.0.1", port, reused: false };
    })();

    // A failed attempt must not be cached — the next call should be free to
    // retry (e.g. after the operator brings the bastion back up).
    endpointPromise.catch(() => {
      endpointPromise = null;
      activeConfig = null;
    });
  }

  return endpointPromise;
}

/** The error recorded when reconnection gave up, if any. */
export function getTunnelFatalError(): Error | null {
  return fatalError;
}

/** Human-readable summary for startup logs and tool responses. */
export function describeTunnel(): string | null {
  if (!SSH_ENABLED) return null;
  if (!activeConfig) return "ssh tunnel: enabled (not yet established)";
  const { sshUser, sshHost, remoteHost, remotePort } = activeConfig;
  return `ssh tunnel: ${sshUser}@${sshHost} -> ${remoteHost}:${remotePort}`;
}

/**
 * Tear the tunnel down. Safe to call more than once and safe to call when no
 * tunnel was ever opened, so shutdown paths don't need to guard.
 */
export async function stopTunnel(): Promise<void> {
  shuttingDown = true;

  const server = localServer;
  localServer = null;
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Sockets held open by a client that never disconnects would stall
      // close(); drop them so shutdown stays bounded.
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
