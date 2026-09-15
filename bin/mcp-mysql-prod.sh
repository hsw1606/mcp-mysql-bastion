#!/usr/bin/env bash
# MCP MySQL 서버 — prod profile. 읽기 전용은 설정이 아니라 코드가 강제한다.
set -euo pipefail
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_mcp-mysql-run.sh" prod
