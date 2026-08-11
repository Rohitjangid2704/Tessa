#!/usr/bin/env bash
set -euo pipefail
psql "${TRUTH_DB_DSN}" -At -c "SELECT md5(string_agg(id::text || status, ',' ORDER BY id)) FROM smart_log_issue WHERE property_id = 'qa-property-1'"
