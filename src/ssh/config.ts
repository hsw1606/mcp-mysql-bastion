import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The subset of `~/.ssh/config` directives this server understands for a single
 * `Host` alias. Everything else in the block is ignored — this is deliberately
 * not a general-purpose OpenSSH config implementation, only enough to reuse an
 * alias the operator has already written by hand.
 */
export interface SSHConfigHostEntry {
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** First `LocalForward` in the block, if any. */
  localForward?: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
  };
}

/** Expand a leading `~` and resolve relative paths against $HOME. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Split an OpenSSH config line into (keyword, value). OpenSSH accepts both
 * `Keyword value` and `Keyword=value`, and keywords are case-insensitive.
 * Returns null for blank lines and comments.
 */
function splitDirective(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  const ws = trimmed.search(/\s/);

  // Pick whichever separator comes first; `=` may legitimately appear inside a
  // value (e.g. a ProxyCommand), so only treat it as the separator when it
  // precedes any whitespace.
  let sepIndex: number;
  if (eq !== -1 && (ws === -1 || eq < ws)) {
    sepIndex = eq;
  } else if (ws !== -1) {
    sepIndex = ws;
  } else {
    return null; // keyword with no value
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
 * Parse a `LocalForward` value. OpenSSH allows several shapes:
 *   LocalForward 3307 db.internal:3306
 *   LocalForward 127.0.0.1:3307 db.internal:3306
 *   LocalForward 3307 db.internal 3306      (rare, space-separated)
 * Returns null for anything we can't read confidently — a half-understood
 * forward is worse than falling back to explicit environment variables.
 */
function parseLocalForward(
  value: string,
): SSHConfigHostEntry["localForward"] | null {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  // Local side: either "port" or "bind:port".
  const localRaw = parts[0];
  const localPortStr = localRaw.includes(":")
    ? localRaw.slice(localRaw.lastIndexOf(":") + 1)
    : localRaw;
  const localPort = Number(localPortStr);
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    return null;
  }

  // Remote side: "host:port", or "host" followed by a separate port token.
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
 * Look up a single `Host` alias in an OpenSSH config file.
 *
 * Matching is intentionally exact (case-insensitive) against the tokens on the
 * `Host` line: the point of `MYSQL_SSH_CONFIG_HOST` is to name an alias the
 * operator already wrote, not to re-implement OpenSSH's wildcard and `Match`
 * semantics. A wildcard block such as `Host *` therefore contributes nothing,
 * which keeps the resolved values predictable.
 *
 * Returns null when the file or the alias does not exist.
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
      // A new Host line always ends the previous block.
      inBlock = value
        .split(/\s+/)
        .some((token) => token.toLowerCase() === wanted);
      if (inBlock) found = true;
      continue;
    }

    // `Match` blocks use conditions we don't evaluate; treat them as the end of
    // the current Host block rather than silently absorbing their directives.
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
        // OpenSSH allows several IdentityFile lines; the first wins here.
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
