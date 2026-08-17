#!/usr/bin/env bash
set -euo pipefail
curl -fsS "${FAKE_TARGET_URL}/qa/hash" | sed -e 's/.*"hash":"\([^"]*\)".*/\1/'
