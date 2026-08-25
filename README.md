# mcp-mysql-bastion

A read-only MySQL MCP server for databases that are only reachable through an
SSH bastion, with one named profile per environment.

It opens the tunnel itself. You point it at an `~/.ssh/config` alias you already
have, and it handles the forward, the connection pool, and the teardown. A
profile named `prod` cannot write, and that is decided in code rather than in
configuration.

## Attribution

Derived from [benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql)
(MIT). The MCP server, query routing, permission model, and PII redaction come
from that project; see [LICENSE.md](LICENSE.md).

New here: the SSH tunnel layer (`src/ssh/`), the profile system, the wrapper
scripts, and stderr-only logging. The remote HTTP transport, test suite, eval
harness, and Docker packaging were dropped — this serves stdio to a local MCP
client and nothing else.

## What you get

- **SSH tunnel.** Opened before the connection pool exists, closed on shutdown.
  Each server owns its own tunnel, so instances never interfere.
- **Profiles.** `MYSQL_PROFILE` picks `.env.<profile>`. Every response says which
  environment answered it.
- **Read-only by default, unbreakable for prod.** `prod`/`production` refuse all
  writes regardless of configuration.
- **stdio-safe logging.** All diagnostics go to stderr, so `ENABLE_LOGGING=true`
  never corrupts the MCP stream.

## Requirements

- Node.js 20+
- SSH access to the bastion, with the key already working (`ssh <alias>` succeeds)
- A MySQL user on the target database

## Setup

### 1. Install and build

```bash
git clone <this repo>
cd mcp-mysql-bastion
npm install
npm run build
```

The build emits `dist/index.js`, which is what the MCP clients execute.

### 2. Describe the bastion in `~/.ssh/config`

The server can read everything it needs from a Host alias, which keeps
credentials and hostnames out of this repo entirely:

```sshconfig
Host my-stage-db
    HostName bastion.stage.example.com
    User dev
    LocalForward 3307 db-stage.cluster-ro.example.rds.amazonaws.com:3306
```

`HostName`, `User`, `Port`, `IdentityFile`, and the first `LocalForward` are all
picked up. Verify it works on its own before going further:

```bash
ssh my-stage-db "echo ok"
```

### 3. Create a profile

```bash
cp .env.example .env.stage
chmod 600 .env.stage
```

With an alias in place, a profile is short:

```dotenv
MYSQL_PROFILE=stage

MYSQL_SSH_ENABLED=true
MYSQL_SSH_CONFIG_HOST=my-stage-db

MYSQL_USER=<user>
MYSQL_PASS=<password>
MYSQL_DB=

ALLOW_INSERT_OPERATION=false
ALLOW_UPDATE_OPERATION=false
ALLOW_DELETE_OPERATION=false
ALLOW_DDL_OPERATION=false
```

Leave `MYSQL_DB` empty for multi-DB mode (`SHOW DATABASES`, cross-schema
queries). Repeat for `.env.prod` with `MYSQL_PROFILE=prod`.

`.env.*` files are gitignored; only `.env.example` is committed. Never put a
real password in a file that gets committed.

### 4. Check the profile before registering it

Run the wrapper directly. It validates the env file, the credentials, and the
SSH key, then waits for MCP traffic on stdin:

```bash
./bin/mcp-mysql-stage.sh
```

Silence is success — it means the server is up and stdout is clean. `Ctrl-C` to
stop. A misconfiguration prints the reason to stderr and exits non-zero.

To see what it is doing, set `ENABLE_LOGGING=true` in the profile and look for
the `[ssh]` lines:

```text
[ssh] resolved alias "my-stage-db" from ~/.ssh/config: {...}
[ssh] opening tunnel dev@bastion.stage.example.com:22 -> db-stage.cluster-ro.example:3306 (local port 3307)
[ssh] tunnel listening on 127.0.0.1:3307
```

### 5. Register with Claude Code

Use absolute paths — the client does not resolve `~` or relative paths:

```bash
claude mcp add mysql-stage -s user -- /absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-stage.sh
claude mcp add mysql-prod  -s user -- /absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-prod.sh
```

`-s user` registers for every project. Use `-s local` to scope to the current
one. Confirm:

```bash
claude mcp list
```

Both should report `✔ Connected`. The registration lands in `~/.claude.json`
under the top-level `mcpServers` key; prefer the CLI over editing that file,
since it also holds per-project state.

To change the path later, remove and re-add:

```bash
claude mcp remove mysql-stage -s user
claude mcp add mysql-stage -s user -- /new/path/bin/mcp-mysql-stage.sh
```

A server already running in an open session keeps its old path until that
session restarts.

### 6. Register with Codex

Codex has no `mcp add`, so append to `~/.codex/config.toml` — append, do not
overwrite:

```toml
[mcp_servers.mysql-stage]
command = "/absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-stage.sh"
args = []
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.mysql-prod]
command = "/absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-prod.sh"
args = []
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Back the file up first; it holds your other MCP servers and their credentials.

```bash
cp ~/.codex/config.toml ~/.codex/config.toml.bak
codex mcp list          # both should show as enabled
```

**On the timeouts.** `startup_timeout_sec` covers the MCP handshake only, which
takes about 0.2s here — the tunnel is opened lazily on the first query, not
during startup, so it does not block `initialize`. The first query pays the SSH
handshake and lands around 3s, which is what `tool_timeout_sec` needs to
accommodate. The values above are roughly 10x the measured numbers.

**On the sandbox.** MCP servers run outside the sandbox that `sandbox_mode`
applies to Codex's own shell, so no sandbox change is needed for the server to
read your SSH key or reach the bastion.

Verify end to end:

```bash
codex exec "Using mysql-stage, run: SELECT 1"
```

## Usage

Ask in terms of the profile, and the environment comes back in the answer:

```text
Using mysql-stage, how many rows are in app.users?
```

```text
[profile: STAGE | read-only | database: multi-db | ssh tunnel: dev@bastion.stage.example.com -> db-stage.cluster-ro.example:3306]
[
  {
    "c": 13369
  }
]
```

Every response carries that banner — success and refusal alike — so a stage
result cannot be mistaken for a prod one. The tool description names the
environment too, since that is what a model reads before choosing a tool.

## Environment variables

### Profile

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYSQL_PROFILE` | *(unset)* | Environment label. `prod`/`production` forces read-only. |
| `MYSQL_ENV_FILE` | *(unset)* | Load exactly this env file instead of `.env.<profile>`. |

### SSH tunnel

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYSQL_SSH_ENABLED` | `false` | Open a tunnel before connecting. |
| `MYSQL_SSH_CONFIG_HOST` | *(unset)* | `~/.ssh/config` Host alias to read `HostName`, `User`, `Port`, `IdentityFile`, and the first `LocalForward` from. |
| `MYSQL_SSH_HOST` | from alias | Bastion hostname. |
| `MYSQL_SSH_PORT` | `22` | Bastion SSH port. |
| `MYSQL_SSH_USER` | from alias | Bastion user. |
| `MYSQL_SSH_PRIVATE_KEY_PATH` | `~/.ssh/id_rsa` | Key used to authenticate to the bastion. |
| `MYSQL_SSH_PASSPHRASE` | *(unset)* | Only for an encrypted key. |
| `MYSQL_SSH_LOCAL_PORT` | alias `LocalForward`, else `0` | Preferred loopback port. `0` auto-assigns. If the port is taken, an auto-assigned one is used instead. |
| `MYSQL_SSH_REUSE_EXISTING` | `false` | Attach to a forward already on that port instead of opening our own. See the warning below. |

Explicit variables always win over the alias, so one profile can override a
single field without touching `~/.ssh/config`.

### MySQL

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | With a tunnel, the database **as seen from the bastion** — the forwarding target, not the address the pool dials. An alias's `LocalForward` target takes precedence. |
| `MYSQL_PORT` | `3306` | Same. |
| `MYSQL_USER` / `MYSQL_PASS` | — | Database credentials. Required. |
| `MYSQL_DB` | *(empty)* | Empty enables multi-DB mode. |
| `MYSQL_POOL_SIZE` | `10` | Pool size. |
| `MYSQL_CONNECT_TIMEOUT` | `10000` | Connect timeout, ms. |
| `MYSQL_BIG_NUMBER_STRINGS` | `false` | Return BIGINT/DECIMAL as strings. Set this if the schema uses snowflake IDs. |
| `MYSQL_DATE_STRINGS` | `false` | Return dates as strings instead of `Date`. |
| `MYSQL_SSL` | `false` | TLS to MySQL (independent of the SSH tunnel). |

### Writes

All default to `false`, and are forced to `false` for a write-forbidden profile
no matter what they are set to.

| Variable | Meaning |
| --- | --- |
| `ALLOW_INSERT_OPERATION` | Permit INSERT. |
| `ALLOW_UPDATE_OPERATION` | Permit UPDATE. |
| `ALLOW_DELETE_OPERATION` | Permit DELETE. |
| `ALLOW_DDL_OPERATION` | Permit CREATE/ALTER/DROP/TRUNCATE. |
| `MULTI_DB_WRITE_MODE` | Permit writes while in multi-DB mode. |
| `SCHEMA_*_PERMISSIONS` | Per-schema overrides, `"db1:true,db2:false"`. |

### Diagnostics

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENABLE_LOGGING` | `false` | Diagnostics to stderr. Safe with any MCP client. |
| `ENABLE_PII_REDACTION` | `false` | Mask likely PII in results. Inherited from upstream. |

## How the tunnel works

The forward is in-process, via `ssh2` — not a spawned `ssh -N -L`. A loopback
listener fronts one SSH connection, and each accepted socket gets its own
`forwardOut` channel, so the pool ends up with several independent MySQL
connections over a single SSH session.

That was chosen over a child process for three reasons:

1. **Cleanup is structural.** The tunnel's lifetime is the process's lifetime.
   There is no child that can outlive the server, so a dangling `ssh` holding a
   forwarded port open is not a failure mode that exists.
2. **Readiness is exact.** "Create the pool only after the port is listening" is
   a `server.listen()` callback rather than a poll.
3. **No borrowed stderr.** A spawned `ssh` writes its own warnings, and some
   bastions are chatty. Nothing it says can reach stdout here.

Behaviour worth knowing:

- The listener binds to `127.0.0.1` only. It grants unauthenticated access to
  the forwarded database and must never be reachable from the network.
- **Each server owns its tunnel.** `MYSQL_SSH_LOCAL_PORT` is a preference, not a
  requirement: if the port is already taken, this server opens its own tunnel on
  an OS-assigned port. Nothing downstream cares about the number, since the pool
  is told where to connect.
- On an unexpected drop the SSH transport is re-established up to three times
  with exponential backoff (1s, 2s, 4s). After that, queries fail with an
  explicit message rather than an opaque `ECONNRESET`.
- Teardown happens on `SIGINT`, `SIGTERM`, and when the client closes stdin.

### Why tunnels are not shared by default

An earlier version attached to any forward already listening on the profile's
port, to avoid opening a second SSH session. That turned out to be the wrong
trade.

A borrowed tunnel lives and dies with the process that opened it, and MCP
clients start and stop servers constantly — `codex exec` tears its server down
at the end of every invocation. So the owner routinely exits first, and every
borrower's in-flight query dies with `PROTOCOL_CONNECTION_LOST`. It presents as
an intermittent, unreproducible tool failure.

Owning a tunnel per server costs one extra SSH session and removes the failure
mode entirely. Set `MYSQL_SSH_REUSE_EXISTING=true` only when the forward is
externally managed and outlives every client — a long-running `ssh -L` you
started yourself.

## Read-only enforcement

For a profile named `prod` or `production`, `src/config/index.ts` forces
`ALLOW_INSERT`, `ALLOW_UPDATE`, `ALLOW_DELETE`, `ALLOW_DDL`, and
`MULTI_DB_WRITE_MODE` to `false`, and blanks the `SCHEMA_*_PERMISSIONS`
overrides.

Blanking the overrides is the part that matters: they are per-schema exceptions
to the global flags, so leaving them intact would let
`SCHEMA_UPDATE_PERMISSIONS=some_db:true` reopen the door the global veto just
closed. `executeWriteQuery` also refuses outright, as a second line of defence
against a future refactor of the routing logic.

The practical consequence: no env file, shell export, or MCP client setting can
make a prod profile write. Attempting it logs the ignored flags to stderr and
carries on read-only.

Other profiles are read-only by default but can opt in, since their `ALLOW_*`
flags are ordinary configuration.

## Troubleshooting

**Client reports a handshake or JSON parse error.** Something wrote to stdout,
which carries the MCP framing. This server routes all logging to stderr, so
suspect a shell profile that echoes on startup (`~/.zshrc`, `~/.bash_profile`)
or a custom wrapper. Check with:

```bash
./bin/mcp-mysql-stage.sh < /dev/null | head
```

Any output at all is the bug.

**`SSH private key not found` or a permission error.** The key path is wrong or
unreadable. `MYSQL_SSH_PRIVATE_KEY_PATH` defaults to `~/.ssh/id_rsa`; the key
must be `chmod 600` and, if encrypted, needs `MYSQL_SSH_PASSPHRASE`.

**`Local port N is already in use`.** Something holds the port but refused our
probe. Find it with `lsof -nP -i :N`, or set `MYSQL_SSH_LOCAL_PORT=0` to
auto-assign.

**Queries fail after working for a while.** The tunnel dropped and reconnection
gave up. The error names the bastion. Restart the server once it is reachable.

**Server exits immediately.** Run the wrapper by hand — startup failures print
the reason to stderr regardless of `ENABLE_LOGGING`.

**A query fails with `PROTOCOL_CONNECTION_LOST` or `Connection lost`.** The
tunnel went away mid-query. With the default settings each server owns its
tunnel, so suspect the bastion or the network. If you set
`MYSQL_SSH_REUSE_EXISTING=true`, the far more likely cause is that the process
owning the shared forward exited — turn the flag back off.

**`git push` rejected: "refusing to allow an OAuth App to create or update
workflow".** An HTTPS remote with a token lacking the `workflow` scope. Use an
SSH remote:

```bash
git remote set-url origin git@github.com:<owner>/<repo>.git
```

## Layout

```text
index.ts              MCP server, tool + resource handlers, shutdown
src/config/           env loading, profile policy, mysql2 options
src/db/               query routing, permission checks, pool
src/security/         PII redaction (upstream)
src/ssh/config.ts     ~/.ssh/config Host alias parser
src/ssh/tunnel.ts     tunnel lifecycle: open, reuse, reconnect, close
bin/                  profile wrappers for MCP clients
```

## License

MIT. See [LICENSE.md](LICENSE.md).
