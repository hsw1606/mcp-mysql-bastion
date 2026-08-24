#!/usr/bin/env bash
# MCP MySQL server — stage profile (read-only).
set -euo pipefail
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_mcp-mysql-run.sh" stage
