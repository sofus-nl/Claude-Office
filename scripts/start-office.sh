#!/usr/bin/env bash
# Deprecated: this is start-office.mjs now (Node only, every OS); this forwards to it.
exec node "$(dirname "${BASH_SOURCE[0]}")/start-office.mjs" "$@"
