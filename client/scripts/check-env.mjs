import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECKED_PREFIXES = ["AUTH_", "API_", "NEXT_PUBLIC_", "CSP_", "E2E_"];
const OPTIONAL_PREFIXES = ["E2E_"];
const ASSIGNMENT_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const COMMENTED_ASSIGNMENT_PATTERN = /^#\s*([A-Z][A-Z0-9_]*)\s*=/;

function hasCheckedPrefix(key) {
  return CHECKED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isOptionalPrefix(key) {
  return OPTIONAL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function parseEnvText(text) {
  const assigned = [];
  const commented = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const assignment = ASSIGNMENT_PATTERN.exec(line);
    if (assignment?.[1]) {
      assigned.push(assignment[1]);
      continue;
    }
    const disabled = COMMENTED_ASSIGNMENT_PATTERN.exec(line);
    if (disabled?.[1]) {
      commented.push(disabled[1]);
    }
  }
  return { assigned, commented };
}

function findDuplicates(keys) {
  return keys.filter((key, index) => keys.indexOf(key) !== index);
}

export function checkEnv({ root, processEnv = {} }) {
  const errors = [];
  const notes = [];
  const examplePath = path.join(root, ".env.example");

  if (!existsSync(examplePath)) {
    return { errors: [".env.example is missing"], notes };
  }

  const example = parseEnvText(readFileSync(examplePath, "utf8"));
  const exampleKeys = [...example.assigned, ...example.commented];

  for (const key of findDuplicates(exampleKeys)) {
    errors.push(`.env.example: duplicate key ${key}`);
  }
  for (const key of exampleKeys) {
    if (!hasCheckedPrefix(key)) {
      errors.push(`.env.example: key ${key} is outside ${CHECKED_PREFIXES.join(", ")}`);
    }
  }

  const knownKeys = new Set(exampleKeys);
  const requiredKeys = example.assigned.filter((key) => !isOptionalPrefix(key));

  const envFiles = readdirSync(root).filter(
    (name) => name.startsWith(".env") && name !== ".env.example",
  );
  const presentKeys = new Set(
    Object.entries(processEnv)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key]) => key),
  );

  for (const name of envFiles) {
    const parsed = parseEnvText(readFileSync(path.join(root, name), "utf8"));
    for (const key of findDuplicates(parsed.assigned)) {
      errors.push(`${name}: duplicate key ${key}`);
    }
    for (const key of parsed.assigned) {
      presentKeys.add(key);
      if (hasCheckedPrefix(key) && !knownKeys.has(key)) {
        errors.push(`${name}: unknown key ${key} (not in .env.example)`);
      }
    }
  }

  if (envFiles.length === 0) {
    notes.push("no .env files found; validated .env.example only");
  } else {
    for (const key of requiredKeys) {
      if (!presentKeys.has(key)) {
        errors.push(`missing required key ${key} (set it in ${envFiles.join(", ")})`);
      }
    }
  }

  return { errors, notes };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { errors, notes } = checkEnv({ root, processEnv: process.env });
  for (const note of notes) {
    console.log(`check-env: ${note}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`check-env: ${error}`);
    }
    process.exit(1);
  }
  console.log("check-env: ok");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
