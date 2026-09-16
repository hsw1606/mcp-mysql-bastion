#!/usr/bin/env bash
# MCP MySQL 서버 — stage profile (읽기 전용).
set -euo pipefail
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_mcp-mysql-run.sh" stage
