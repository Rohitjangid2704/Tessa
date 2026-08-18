SELECT 'CREATE ROLE truth_ro LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truth_ro') \gexec
SELECT 'CREATE ROLE seed_rw LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seed_rw') \gexec

ALTER ROLE truth_ro WITH LOGIN PASSWORD 'dev-only-truth-ro-password';
ALTER ROLE seed_rw WITH LOGIN PASSWORD 'dev-only-seed-rw-password';
ALTER ROLE truth_ro SET default_transaction_read_only = on;

SELECT 'CREATE DATABASE truth_fixture'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'truth_fixture') \gexec

REVOKE ALL ON DATABASE truth_fixture FROM PUBLIC;
GRANT CONNECT ON DATABASE truth_fixture TO truth_ro, seed_rw;

\connect truth_fixture

CREATE TABLE IF NOT EXISTS rooms (
    id integer PRIMARY KEY,
    number text NOT NULL UNIQUE,
    floor integer NOT NULL,
    status text NOT NULL CHECK (status IN ('clean', 'dirty'))
);

CREATE TABLE IF NOT EXISTS issues (
    id integer PRIMARY KEY,
    room_id integer NOT NULL REFERENCES rooms (id),
    description text NOT NULL,
    status text NOT NULL CHECK (status IN ('open', 'closed')),
    created_at timestamptz NOT NULL
);

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO truth_ro, seed_rw;
GRANT SELECT ON rooms, issues TO truth_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON rooms, issues TO seed_rw;

INSERT INTO rooms (id, number, floor, status) VALUES
    (1, '20001', 2, 'clean'),
    (2, '20002', 2, 'dirty'),
    (3, '20003', 2, 'dirty'),
    (4, '20004', 2, 'clean'),
    (5, '20005', 3, 'dirty'),
    (6, '20006', 3, 'clean'),
    (7, '20007', 3, 'clean'),
    (8, '20008', 3, 'clean')
ON CONFLICT (id) DO NOTHING;

INSERT INTO issues (id, room_id, description, status, created_at) VALUES
    (9101, 3, 'shower leaks', 'open', '2026-09-01T08:00:00Z'),
    (9102, 3, 'light flickers', 'open', '2026-09-02T08:00:00Z'),
    (9103, 5, 'tv remote missing', 'open', '2026-09-03T08:00:00Z'),
    (9104, 1, 'door sticks', 'closed', '2026-09-04T08:00:00Z'),
    (9105, 7, 'air conditioning is noisy', 'closed', '2026-09-05T08:00:00Z')
ON CONFLICT (id) DO NOTHING;
