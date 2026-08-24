#!/usr/bin/env bash
# MCP MySQL server — prod profile. Read-only is enforced in code, not config.
set -euo pipefail
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_mcp-mysql-run.sh" prod
