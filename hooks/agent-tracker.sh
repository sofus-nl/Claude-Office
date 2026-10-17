#!/usr/bin/env bash
# Deprecated: the hook is hooks/agent-tracker.mjs now (Node only, every OS). Hook entries
# installed before it still point here; npm run install-hooks repoints them.
exec node "$(dirname "${BASH_SOURCE[0]}")/agent-tracker.mjs" "$@"
