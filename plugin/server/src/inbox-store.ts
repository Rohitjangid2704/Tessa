import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INBOX_CAP = 200;

export function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

export interface InboxStore {
  append(lines: string[], at: string): Promise<void>;
  read(): Promise<string[]>;
  take(): Promise<string[]>;
}

function encodeEntry(line: string, at: string): string {
  return `${JSON.stringify({ at, line })}\n`;
}

export function decodeEntries(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) {
      continue;
    }
    let line = raw;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { line?: unknown }).line === "string") {
        line = (parsed as { line: string }).line;
      }
    } catch {
      line = raw;
    }
    lines.push(line);
  }
  return lines;
}

export class MemoryInboxStore implements InboxStore {
  private entries: string[] = [];

  async append(lines: string[]): Promise<void> {
    this.entries = [...this.entries, ...lines].slice(-INBOX_CAP);
  }

  async read(): Promise<string[]> {
    return [...this.entries];
  }

  async take(): Promise<string[]> {
    const taken = this.entries;
    this.entries = [];
    return taken;
  }
}

export class FileInboxStore implements InboxStore {
  private chain: Promise<unknown> = Promise.resolve();
  readonly path: string;

  constructor(
    private readonly directory: string,
    sessionName: string,
  ) {
    this.path = join(directory, `${safeFileName(sessionName)}.jsonl`);
  }

  append(lines: string[], at: string): Promise<void> {
    return this.serialised(async () => {
      if (lines.length === 0) {
        return;
      }
      await mkdir(this.directory, { recursive: true });
      const existing = await this.readEntries();
      if (existing.length + lines.length <= INBOX_CAP) {
        await appendFile(this.path, lines.map((line) => encodeEntry(line, at)).join(""), "utf8");
        return;
      }
      const kept = [...existing, ...lines].slice(-INBOX_CAP);
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, kept.map((line) => encodeEntry(line, at)).join(""), "utf8");
      await rename(temporary, this.path);
    });
  }

  read(): Promise<string[]> {
    return this.serialised(() => this.readEntries());
  }

  take(): Promise<string[]> {
    return this.serialised(async () => {
      const taken = `${this.path}.${process.pid}.taking`;
      try {
        await rename(this.path, taken);
      } catch {
        return [];
      }
      try {
        return decodeEntries(await readFile(taken, "utf8")).slice(-INBOX_CAP);
      } finally {
        await rm(taken, { force: true });
      }
    });
  }

  private async readEntries(): Promise<string[]> {
    try {
      return decodeEntries(await readFile(this.path, "utf8"));
    } catch {
      return [];
    }
  }

  private serialised<Value>(task: () => Promise<Value>): Promise<Value> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export async function pruneStaleFiles(dataDir: string, maxAgeMilliseconds: number, now: number): Promise<number> {
  let removed = 0;
  for (const folder of ["inbox", "sessions"]) {
    const directory = join(dataDir, folder);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const path = join(directory, name);
        const info = await stat(path);
        if (info.isFile() && now - info.mtimeMs > maxAgeMilliseconds) {
          await rm(path, { force: true });
          removed += 1;
        }
      } catch {
        continue;
      }
    }
  }
  return removed;
}

export async function writeSessionFile(
  dataDir: string,
  claudeSessionId: string,
  content: { agent_session_id: string; claude_session_id: string; target_id: string | null },
  now: string,
): Promise<string> {
  const directory = join(dataDir, "sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${safeFileName(claudeSessionId)}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...content, written_at: now })}\n`, "utf8");
  await rename(temporary, path);
  return path;
}
