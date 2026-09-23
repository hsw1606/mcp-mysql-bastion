#!/usr/bin/env bash
#
# 이 디렉터리의 profile wrapper들이 함께 쓰는 launcher.
#
# MCP 클라이언트와의 약속: stdout에는 MCP 프로토콜만 실린다. 여기서 나가는
# 진단은 전부 stderr로 보낸다. stdout에 한 줄만 새어 나가도 Claude Code와
# Codex 양쪽에서 handshake가 깨진다.
#
# 사용법: _mcp-mysql-run.sh <profile>

set -euo pipefail

PROFILE="${1:?internal error: profile argument is required}"

# 저장소 루트를 이 스크립트 자신의 위치에서 찾는다. MCP 클라이언트가 어느
# 디렉터리에서 띄우든 wrapper가 동작하게 하기 위해서다.
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

# profile을 읽는다. `set -a`가 파일이 정의한 것을 전부 export하므로 Node
# 프로세스가 그대로 물려받는다. 이렇게 export한 값은 서버 안의 dotenv 로드보다
# 우선한다.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# MYSQL_PROFILE이 읽기 전용 정책과 환경 배너를 결정한다. env 파일이 빠뜨렸더라도
# 이 값만은 맞아야 한다.
export MYSQL_PROFILE="${PROFILE}"
export MYSQL_ENV_FILE="${ENV_FILE}"

missing=()
for var in MYSQL_USER MYSQL_PASS; do
  [ -n "${!var:-}" ] || missing+=("${var}")
done

# tunnel에는 ssh_config alias가 있거나, host와 user를 직접 적어야 한다.
#
# 키 파일은 여기서 확인하지 않는다. 서버는 키를 MYSQL_SSH_PRIVATE_KEY_PATH,
# alias의 IdentityFile, ~/.ssh/id_rsa 순으로 고르는데, 여기서 같은 확인을 하려면
# ssh_config 해석을 bash로 한 벌 더 만들어야 한다. 한때 앞의 하나와 마지막
# 하나만 보는 확인이 있었고, IdentityFile을 적은 alias를 id_rsa가 없다는 이유로
# 거절했다. 키가 없으면 서버의 resolveTunnelConfig()가 경로를 밝히며 멈춘다.
if [ "${MYSQL_SSH_ENABLED:-false}" = "true" ] && [ -z "${MYSQL_SSH_CONFIG_HOST:-}" ]; then
  for var in MYSQL_SSH_HOST MYSQL_SSH_USER; do
    [ -n "${!var:-}" ] || missing+=("${var}")
  done
fi

if [ ${#missing[@]} -gt 0 ]; then
  die "missing required variable(s) in ${ENV_FILE}: ${missing[*]}"
fi

# 저장소 루트에서 실행한다. 서버가 푸는 상대 경로가 흔들리지 않게 하기 위해서다.
cd "${REPO_ROOT}"
exec node "${ENTRYPOINT}"
