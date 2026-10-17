#!/usr/bin/env bash
# Deprecated: this is install-hooks.mjs now (Node only, every OS); this forwards to it.
exec node "$(dirname "${BASH_SOURCE[0]}")/install-hooks.mjs" "$@"
