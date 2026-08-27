import { basename } from "node:path";
import { unwrap, type TessaApi } from "./client";

export class SessionState {
  id: string | undefined;
  targetId: string | undefined;
  targetToken: string | undefined;
}

export type SessionOptions = {
  claudeSessionId: string;
  cwd: string;
  pluginVersion: string;
  log: (message: string, fields?: Record<string, unknown>) => void;
  onSession?: (agentSessionId: string) => void | Promise<void>;
  onTarget?: (targetId: string) => void;
};

const SETTLE_WAIT_MILLISECONDS = 2000;
const END_WAIT_MILLISECONDS = 3000;

function withTimeout<Value>(pending: Promise<Value>, milliseconds: number): Promise<Value | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export class SessionTracker {
  private startPromise: Promise<void> | null = null;
  private endPromise: Promise<void> | null = null;

  constructor(
    readonly state: SessionState,
    private readonly api: TessaApi,
    private readonly options: SessionOptions,
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.createSession();
    return this.startPromise;
  }

  async settled(): Promise<void> {
    if (this.startPromise !== null) {
      await withTimeout(this.startPromise, SETTLE_WAIT_MILLISECONDS);
    }
  }

  async selectTarget(target: { id: string; target_token: string }): Promise<void> {
    this.state.targetId = target.id;
    this.state.targetToken = target.target_token;
    this.options.onTarget?.(target.id);
    await this.settled();
    const sessionId = this.state.id;
    if (sessionId === undefined) {
      return;
    }
    try {
      await unwrap(
        this.api.client.PATCH("/api/v1/agent-sessions/{agent_session_id}", {
          params: { path: { agent_session_id: sessionId } },
          body: { target_id: target.id },
        }),
      );
    } catch (error) {
      this.options.log("agent session target update failed", { error: String(error) });
    }
  }

  end(): Promise<void> {
    this.endPromise ??= withTimeout(this.finish(), END_WAIT_MILLISECONDS).then(() => undefined);
    return this.endPromise;
  }

  private async createSession(): Promise<void> {
    let createdId: string;
    try {
      const created = await unwrap(
        this.api.client.POST("/api/v1/agent-sessions", {
          body: {
            claude_session_id: this.options.claudeSessionId,
            cwd_label: (basename(this.options.cwd) || "unknown").slice(0, 120),
            plugin_version: this.options.pluginVersion,
            target_id: this.state.targetId ?? null,
          },
        }),
      );
      this.state.id = created.id;
      createdId = created.id;
    } catch (error) {
      this.options.log("agent session was not created", { error: String(error) });
      return;
    }
    try {
      await this.options.onSession?.(createdId);
    } catch (error) {
      this.options.log("agent session file was not written", { error: String(error) });
    }
  }

  private async finish(): Promise<void> {
    if (this.startPromise !== null) {
      await this.startPromise;
    }
    const sessionId = this.state.id;
    if (sessionId === undefined) {
      return;
    }
    try {
      await unwrap(
        this.api.client.PATCH("/api/v1/agent-sessions/{agent_session_id}", {
          params: { path: { agent_session_id: sessionId } },
          body: { ended_at: new Date().toISOString() },
        }),
      );
    } catch (error) {
      this.options.log("agent session end failed", { error: String(error) });
    }
  }
}
