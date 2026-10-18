import {
  query,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type UserContent = SDKUserMessage["message"]["content"];

/** Push-based async iterable: the SDK keeps one CLI process alive and reads user turns from it. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(item: SDKUserMessage) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface SessionConfig {
  cwd: string;
  claudePath: string;
  env: Record<string, string>;
  model?: string;
  permissionMode: PermissionMode;
  resume?: string;
  showThinking: boolean;
  appendSystemPrompt: string;
  canUseTool: CanUseTool;
  onMessage(message: SDKMessage): void;
  onError(error: unknown, stderr: string): void;
  onExit(): void;
}

export class ClaudeSession {
  private q: Query | null = null;
  private input = new InputQueue();
  private abort = new AbortController();
  private stderr: string[] = [];
  private closed = false;
  sessionId: string | null;
  model?: string;
  permissionMode: PermissionMode;

  constructor(private config: SessionConfig) {
    this.sessionId = config.resume ?? null;
    this.model = config.model;
    this.permissionMode = config.permissionMode;
  }

  get alive(): boolean {
    return this.q !== null;
  }

  private start() {
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.stderr = [];
    const options: Options = {
      cwd: this.config.cwd,
      pathToClaudeCodeExecutable: this.config.claudePath,
      env: this.config.env,
      model: this.model,
      permissionMode: this.permissionMode,
      resume: this.sessionId ?? undefined,
      canUseTool: this.config.canUseTool,
      includePartialMessages: true,
      abortController: this.abort,
      systemPrompt: { type: "preset", preset: "claude_code", append: this.config.appendSystemPrompt },
      thinking: this.config.showThinking ? { type: "adaptive", display: "summarized" } : undefined,
      stderr: (data) => {
        this.stderr.push(data);
        if (this.stderr.length > 40) this.stderr.shift();
      },
    };
    const q = query({ prompt: this.input, options });
    this.q = q;
    void (async () => {
      try {
        for await (const message of q) {
          if ("session_id" in message && message.session_id) this.sessionId = message.session_id;
          this.config.onMessage(message);
        }
      } catch (error) {
        if (!this.abort.signal.aborted) this.config.onError(error, this.stderr.join("").trim());
      } finally {
        if (this.q === q) this.q = null;
        if (!this.closed) this.config.onExit();
      }
    })();
  }

  send(content: UserContent) {
    if (this.closed) return;
    if (!this.q) this.start();
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async interrupt() {
    await this.q?.interrupt().catch(() => undefined);
  }

  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode;
    await this.q?.setPermissionMode(mode).catch(() => undefined);
  }

  async setModel(model?: string) {
    this.model = model;
    await this.q?.setModel(model).catch(() => undefined);
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return (await this.q?.supportedModels().catch(() => undefined)) ?? [];
  }

  close() {
    this.closed = true;
    this.input.close();
    this.abort.abort();
    this.q?.close();
    this.q = null;
  }
}
