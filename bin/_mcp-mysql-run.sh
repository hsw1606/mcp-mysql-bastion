#!/usr/bin/env bash
#
# Shared launcher for the profile wrappers in this directory.
#
# Contract with the MCP client: stdout carries the MCP protocol and nothing
# else. Every diagnostic here goes to stderr — a single stray line on stdout
# breaks the handshake in both Claude Code and Codex.
#
# Usage: _mcp-mysql-run.sh <profile>

set -euo pipefail

PROFILE="${1:?internal error: profile argument is required}"

# Resolve the repository root from this script's own location so the wrappers
# work no matter what directory the MCP client launches them from.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

die() {
  echo "[mcp-mysql:${PROFILE}] $*" >&2
  exit 1
}

ENV_FILE="${REPO_ROOT}/.env.${PROFILE}"
[ -f "${ENV_FILE}" ] || die "env file not found: ${ENV_FILE}
Copy .env.example to .env.${PROFILE} and fill in the real values."

ENTRYPOINT="${REPO_ROOT}/dist/index.js"
[ -f "${ENTRYPOINT}" ] || die "build output not found: ${ENTRYPOINT}
Run 'npm install && npm run build' in ${REPO_ROOT} first."

# Load the profile. `set -a` exports everything the file defines so the Node
# process inherits it; these exported values also take precedence over the
# dotenv load inside the server.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# MYSQL_PROFILE drives the read-only policy and the environment banner, so it
# must be right even if the env file forgot it.
export MYSQL_PROFILE="${PROFILE}"
export MYSQL_ENV_FILE="${ENV_FILE}"

missing=()
for var in MYSQL_USER MYSQL_PASS; do
  [ -n "${!var:-}" ] || missing+=("${var}")
done

# The tunnel needs either an ssh_config alias or an explicit host+user pair.
if [ "${MYSQL_SSH_ENABLED:-false}" = "true" ]; then
  if [ -z "${MYSQL_SSH_CONFIG_HOST:-}" ]; then
    for var in MYSQL_SSH_HOST MYSQL_SSH_USER; do
      [ -n "${!var:-}" ] || missing+=("${var}")
    done
  fi
  KEY_PATH="${MYSQL_SSH_PRIVATE_KEY_PATH:-${HOME}/.ssh/id_rsa}"
  # Expand a leading ~ the same way the server does.
  KEY_PATH="${KEY_PATH/#\~/${HOME}}"
  [ -r "${KEY_PATH}" ] || die "SSH private key is not readable: ${KEY_PATH}
If this runs under a sandbox, grant read access to the key and outbound network access."
fi

if [ ${#missing[@]} -gt 0 ]; then
  die "missing required variable(s) in ${ENV_FILE}: ${missing[*]}"
fi

# Run from the repo root so any relative path the server resolves is stable.
cd "${REPO_ROOT}"
exec node "${ENTRYPOINT}"
