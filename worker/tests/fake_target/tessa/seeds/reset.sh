#!/usr/bin/env bash
set -euo pipefail
curl -fsS -X POST "${FAKE_TARGET_URL}/qa/reset"
