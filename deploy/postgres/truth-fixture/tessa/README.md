# Truth Fixture Hotel bundle

Fixture bundle for the `truth_fixture` Postgres database created by `deploy/postgres/init/02-truth-fixture.sql`.

- `seeds/reset.sql` deletes and re-inserts the 8 rooms and 5 maintenance issues in one transaction, on the write connection `SEED_DB_DSN` (role `seed_rw`).
- `seeds/hash.py` prints a hash of both tables, read through `TRUTH_DB_DSN` (role `truth_ro`); a changed row changes the hash.
- `oracle/open_issues` and `oracle/dirty_rooms` compute the expected answers from the same tables, read-only.

Zip this folder with its files at the archive root or under `tessa/`, put your own `target_token` in `manifest.yaml`, and upload it. The connection strings are set in the Environment page and never appear in the bundle.
