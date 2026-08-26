import { randomBytes } from "node:crypto";
import { COMPOSE_FILE, REPOSITORY_ROOT, runCommand } from "./stack";

const SUPERUSER = "tessa";
const ADMIN_DATABASE = "tessa";
const TRUTH_DATABASE = "gate_truth";
const TRUTH_ROLE = "gate_truth_reader";
const POSTGRES_SERVICE_PORT = "5432";

export function runSql(sql: string, database: string = ADMIN_DATABASE): string {
  return runCommand(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      SUPERUSER,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    REPOSITORY_ROOT,
    `${sql}\n`,
  ).trim();
}

export function publishedPostgresAddress(): string {
  const mapping = runCommand(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "port", "postgres", POSTGRES_SERVICE_PORT],
    REPOSITORY_ROOT,
  ).trim();
  return mapping.replace("0.0.0.0", "127.0.0.1");
}

export interface TruthDatabase {
  dsn: string;
  password: string;
  drop: () => void;
}

export function createTruthDatabase(): TruthDatabase {
  const password = `dev-only-gate-truth-${randomBytes(6).toString("hex")}`;
  dropTruthDatabase();
  runSql(`CREATE ROLE ${TRUTH_ROLE} LOGIN PASSWORD '${password}'`);
  runSql(`CREATE DATABASE ${TRUTH_DATABASE} OWNER ${TRUTH_ROLE}`);
  const address = publishedPostgresAddress();
  return {
    dsn: `postgresql://${TRUTH_ROLE}:${password}@${address}/${TRUTH_DATABASE}`,
    password,
    drop: dropTruthDatabase,
  };
}

export function dropTruthDatabase(): void {
  runSql(`DROP DATABASE IF EXISTS ${TRUTH_DATABASE} WITH (FORCE)`);
  runSql(`DROP ROLE IF EXISTS ${TRUTH_ROLE}`);
}

export function countStoredValues(targetId: string): number {
  return Number(
    runSql(
      `SELECT count(*) FROM environments WHERE target_id = '${targetId}' AND encrypted_value IS NOT NULL`,
    ),
  );
}

export function countRowsContaining(targetId: string, plaintext: string): number {
  const escaped = plaintext.replaceAll("'", "''");
  return Number(
    runSql(
      `SELECT count(*) FROM environments WHERE target_id = '${targetId}' AND position(convert_to('${escaped}', 'UTF8') in encrypted_value) > 0`,
    ),
  );
}

export function countBundleRows(targetId: string): number {
  return Number(runSql(`SELECT count(*) FROM bundles WHERE target_id = '${targetId}'`));
}
