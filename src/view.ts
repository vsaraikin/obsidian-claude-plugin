/* eslint-disable @typescript-eslint/no-explicit-any -- SDK messages are handled structurally */
import {
  Component,
  FileSystemAdapter,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  prepareFuzzySearch,
  setIcon,
} from "obsidian";
import {
  getSessionMessages,
  listSessions,
  type CanUseTool,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type AgentSidebarPlugin from "./main";
import { buildEnv, findClaude, loadShellEnv } from "./env";
import { ClaudeSession, type UserContent } from "./session";
import {
  EDIT_TOOLS,
  HIDDEN_TOOLS,
  diffStats,
  formatDuration,
  relativeTime,
  renderDiff,
  renderTodos,
  resultText,
  summarizeTool,
  toolDiff,
  type Input,
  type Todo,
} from "./render";

export const VIEW_TYPE = "agent-sidebar-chat";

const MODES: { id: PermissionMode; label: string; icon: string }[] = [
  { id: "default", label: "Ask before edits", icon: "hand" },
  { id: "acceptEdits", label: "Edit automatically", icon: "pencil" },
  { id: "plan", label: "Plan mode", icon: "list-checks" },
  { id: "auto", label: "Auto mode", icon: "zap" },
];

const DEFAULT_MODELS = [
  { value: "default", displayName: "Default", description: "Recommended model" },
  { value: "opus", displayName: "Opus", description: "" },
  { value: "sonnet", displayName: "Sonnet", description: "" },
  { value: "haiku", displayName: "Haiku", description: "" },
] as ModelInfo[];

const VERBS = ["Thinking", "Pondering", "Noodling", "Brewing", "Musing", "Clauding", "Percolating", "Cogitating", "Tinkering", "Synthesizing"];
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

const STARTERS = [
  "Summarize the open note",
  "Find notes related to this one",
  "Fix grammar and typos in this note",
  "What have I written about recently?",
];

const SYSTEM_APPEND = [
  "You are running inside Obsidian as a chat panel next to the user's notes.",
  "The working directory is the user's Obsidian vault. Notes are Markdown files; refer to them by vault-relative path.",
  "Work inside this vault. Do not read or change other folders on the computer unless the user asks for it.",
  "Keep Obsidian syntax intact when editing: [[wikilinks]], embeds, frontmatter properties, callouts and tags.",
  "Messages may include an <obsidian_context> block with the open note, the selected lines and notes the user mentioned with @.",
].join("\n");

interface ToolView {
  name: string;
  input: Input;
  item: HTMLElement;
  verbEl: HTMLElement;
  targetEl: HTMLElement;
  metaEl: HTMLElement;
  body: HTMLElement;
  children: HTMLElement;
  done: boolean;
  error: boolean;
  result?: string;
}

interface TextBlock {
  el: HTMLElement;
  buf: string;
  comp: Component | null;
  timer: number | null;
  seq: number;
}

interface Attachment {
  name: string;
  mediaType: string;
  data: string;
}

interface SuggestItem {
  label: string;
  detail?: string;
  icon?: string;
  apply: () => void;
}

type PermissionOptions = Parameters<CanUseTool>[2];

const quote = (path: string) => (/\s/.test(path) ? `"${path}"` : path);

function cleanUserText(text: string): string {
  const t = text.trim();
  const command = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1] ?? "";
    return `${command[1].startsWith("/") ? "" : "/"}${command[1]} ${args}`.trim();
  }
  if (t.startsWith("<") || t.startsWith("Caveat:") || t.startsWith("[Request interrupted")) return "";
  return t;
}

function sessionTitle(s: SDKSessionInfo): string {
  const raw = s.customTitle || s.summary || s.firstPrompt || "Untitled";
  const t = cleanUserText(raw.replace(/<obsidian_context>[\s\S]*?<\/obsidian_context>/g, "")) || "Untitled";
  return t.length > 90 ? `${t.slice(0, 90)}…` : t;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class ChatView extends ItemView {
  private session: ClaudeSession | null = null;
  private resumeId: string | null = null;
  private running = false;
  private pending = 0;
  private turnStart = 0;
  private outputTokens = 0;
  private msgTokens = 0;
  /** Prompt size of the latest API request: what currently sits in the context window. */
  private ctxTokens = 0;
  private mode: PermissionMode;
  private model: string;
  private models: ModelInfo[] = DEFAULT_MODELS;
  private slashCommands: string[] = [];
  private convTitle = "";
  private promptHistory: string[] = [];
  private attachments: Attachment[] = [];
  private noteEnabled: boolean;
  private lastMarkdown: MarkdownView | null = null;
  private tools = new Map<string, ToolView>();
  private texts = new Map<string, TextBlock>();
  private thinking = new Map<string, TextBlock>();
  private streamedIds = new Set<string>();
  private currentMsgId = "";
  private spinTimer: number | null = null;
  private suggestItems: SuggestItem[] = [];
  private suggestIdx = 0;

  private uiTitle!: HTMLElement;
  private uiScroll!: HTMLElement;
  private uiMessages!: HTMLElement;
  private uiWorking!: HTMLElement;
  private uiHistory!: HTMLElement;
  private uiTodos!: HTMLElement;
  private uiSuggest!: HTMLElement;
  private uiChips!: HTMLElement;
  private uiInput!: HTMLTextAreaElement;
  private uiModeBtn!: HTMLButtonElement;
  private uiModelBtn!: HTMLButtonElement;
  private uiCtx!: HTMLElement;
  private uiSend!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private plugin: AgentSidebarPlugin) {
    super(leaf);
    this.mode = plugin.settings.permissionMode;
    this.model = plugin.settings.model;
    this.noteEnabled = plugin.settings.includeActiveNote;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Agent Sidebar";
  }

  getIcon() {
    return "agent-sidebar";
  }

  private get vaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : process.cwd();
  }

  async onOpen() {
    this.build();
    // Opening the panel makes it the active leaf, so fall back to the note last used in the main area.
    const recent = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    this.trackEditor(this.app.workspace.getActiveViewOfType(MarkdownView) ?? (recent instanceof MarkdownView ? recent : null));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) this.trackEditor(leaf.view);
      }),
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.renderChips()));
    const { restoreLastConversation, lastSessionId, lastSessionTitle } = this.plugin.settings;
    if (restoreLastConversation && lastSessionId) await this.openSession(lastSessionId, lastSessionTitle || "Conversation", true);
  }

  async onClose() {
    this.session?.close();
    this.session = null;
    this.stopSpinner();
  }

  private trackEditor(view: MarkdownView | null) {
    if (view) this.lastMarkdown = view;
    this.renderChips();
  }

  // ---------------------------------------------------------------- layout

  private build() {
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-view");

    const header = root.createDiv({ cls: "cc-header" });
    const brand = header.createDiv({ cls: "cc-brand" });
    setIcon(brand.createSpan({ cls: "cc-logo" }), "agent-sidebar");
    this.uiTitle = brand.createSpan({ cls: "cc-title", text: "Agent Sidebar" });
    const actions = header.createDiv({ cls: "cc-header-actions" });
    this.iconButton(actions, "history", "Session history", () => void this.toggleHistory());
    this.iconButton(actions, "plus", "New conversation", () => this.newConversation());
    this.iconButton(actions, "more-horizontal", "More", (e) => this.moreMenu(e));

    this.uiScroll = root.createDiv({ cls: "cc-scroll" });
    this.uiMessages = this.uiScroll.createDiv({ cls: "cc-messages" });
    this.uiWorking = this.uiScroll.createDiv({ cls: "cc-working is-hidden" });
    this.uiHistory = root.createDiv({ cls: "cc-history is-hidden" });
    this.registerDomEvent(this.uiMessages, "click", (e) => this.onMessagesClick(e));

    this.uiTodos = root.createDiv({ cls: "cc-todos is-hidden" });
    const composer = root.createDiv({ cls: "cc-composer" });
    this.uiSuggest = composer.createDiv({ cls: "cc-suggest is-hidden" });
    const box = composer.createDiv({ cls: "cc-box" });
    this.uiChips = box.createDiv({ cls: "cc-chips" });
    this.uiInput = box.createEl("textarea", {
      cls: "cc-input",
      attr: { rows: "1", placeholder: "Ask Claude to edit, research or plan" },
    });
    const footer = box.createDiv({ cls: "cc-footer" });
    const left = footer.createDiv({ cls: "cc-footer-left" });
    this.uiModeBtn = left.createEl("button", { cls: "cc-pill", attr: { "aria-label": "Permission mode (Shift+Tab)" } });
    this.uiModeBtn.onclick = (e) => this.modeMenu(e);
    this.uiModelBtn = left.createEl("button", { cls: "cc-pill", attr: { "aria-label": "Model" } });
    this.uiModelBtn.onclick = (e) => this.modelMenu(e);
    this.uiCtx = left.createSpan({ cls: "cc-ctx" });
    const right = footer.createDiv({ cls: "cc-footer-right" });
    this.iconButton(right, "at-sign", "Mention a note", () => this.insertText("@"));
    this.uiSend = right.createEl("button", { cls: "cc-send" });
    this.uiSend.onclick = () => {
      if (this.running && !this.uiInput.value.trim()) void this.session?.interrupt();
      else this.send();
    };

    this.registerDomEvent(this.uiInput, "input", () => {
      this.autosize();
      this.updateSuggest();
      this.updateSend();
    });
    this.registerDomEvent(this.uiInput, "keydown", (e) => this.onKey(e));
    this.registerDomEvent(this.uiInput, "paste", (e) => void this.onPaste(e));
    this.registerDomEvent(this.uiInput, "focus", () => this.renderChips());
    this.registerDomEvent(this.uiInput, "blur", () => window.setTimeout(() => this.hideSuggest(), 150));

    this.updateModeBtn();
    this.updateModelBtn();
    this.updateSend();
    this.renderEmpty();
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void) {
    const btn = parent.createEl("button", { cls: "cc-icon-btn clickable-icon", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.onclick = onClick;
    return btn;
  }

  private renderEmpty() {
    if (this.uiMessages.childElementCount) return;
    const empty = this.uiMessages.createDiv({ cls: "cc-empty" });
    setIcon(empty.createDiv({ cls: "cc-empty-logo" }), "agent-sidebar");
    empty.createDiv({ cls: "cc-empty-title", text: "What can I help you with?" });
    empty.createDiv({ cls: "cc-empty-sub", text: "Runs your local Claude Code in this vault, so it can read, search and edit your notes." });
    const list = empty.createDiv({ cls: "cc-starters" });
    for (const s of STARTERS) {
      const b = list.createEl("button", { cls: "cc-starter", text: s });
      b.onclick = () => this.send(s);
    }
    void this.renderRecent(empty);
  }

  private async recentSessions(limit: number): Promise<SDKSessionInfo[]> {
    const sessions = await listSessions({ dir: this.vaultPath, limit: 200 }).catch(() => [] as SDKSessionInfo[]);
    return sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  }

  private async renderRecent(empty: HTMLElement) {
    const sessions = await this.recentSessions(3);
    if (!sessions.length || !empty.isConnected) return;
    const box = empty.createDiv({ cls: "cc-recent" });
    const head = box.createDiv({ cls: "cc-recent-head" });
    head.createSpan({ text: "Recent conversations" });
    const all = head.createEl("button", { cls: "cc-link-btn", text: "View all" });
    all.onclick = () => void this.showHistory();
    for (const s of sessions) {
      const title = sessionTitle(s);
      const row = box.createEl("button", { cls: "cc-recent-item" });
      row.createSpan({ cls: "cc-recent-title", text: title });
      row.createSpan({ cls: "cc-recent-time", text: relativeTime(s.lastModified) });
      row.onclick = () => void this.openSession(s.sessionId, title);
    }
  }

  /** Continues the most recently active conversation in this vault. */
  async resumeLast() {
    const [last] = await this.recentSessions(1);
    if (!last) {
      new Notice("No conversations in this vault yet");
      return;
    }
    await this.openSession(last.sessionId, sessionTitle(last));
  }

  private rememberSession(id: string, title: string) {
    const s = this.plugin.settings;
    if (s.lastSessionId === id && s.lastSessionTitle === title) return;
    s.lastSessionId = id;
    s.lastSessionTitle = title;
    void this.plugin.saveSettings();
  }

  private clearEmpty() {
    this.uiMessages.querySelector(".cc-empty")?.remove();
  }

  private setTitle(text: string) {
    this.convTitle = text.replace(/\s+/g, " ").trim();
    this.uiTitle.setText(this.convTitle ? (this.convTitle.length > 48 ? `${this.convTitle.slice(0, 48)}…` : this.convTitle) : "Agent Sidebar");
    this.uiTitle.setAttr("aria-label", this.convTitle || "Agent Sidebar");
  }

  private nearBottom(): boolean {
    const el = this.uiScroll;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  private scrollDown(force = false) {
    if (force || this.nearBottom()) this.uiScroll.scrollTop = this.uiScroll.scrollHeight;
  }

  focusInput() {
    this.uiInput?.focus();
  }

  // ---------------------------------------------------------------- transcript

  private addUser(text: string, extras: string[]) {
    this.clearEmpty();
    const bubble = this.uiMessages.createDiv({ cls: "cc-user" }).createDiv({ cls: "cc-user-bubble" });
    bubble.createDiv({ cls: "cc-user-text", text });
    if (extras.length) {
      const row = bubble.createDiv({ cls: "cc-user-extras" });
      for (const x of extras) row.createSpan({ cls: "cc-mini-chip", text: x });
    }
    this.scrollDown(true);
  }

  private addItem(cls: string, parent: HTMLElement = this.uiMessages) {
    this.clearEmpty();
    const item = parent.createDiv({ cls: `cc-item ${cls}` });
    item.createSpan({ cls: "cc-dot" });
    const body = item.createDiv({ cls: "cc-item-body" });
    this.scrollDown();
    return { item, body };
  }

  private addNote(text: string) {
    this.clearEmpty();
    this.uiMessages.createDiv({ cls: "cc-note", text });
    this.scrollDown();
  }

  private addError(text: string, details?: string) {
    this.clearEmpty();
    const card = this.uiMessages.createDiv({ cls: "cc-error" });
    const head = card.createDiv({ cls: "cc-error-head" });
    setIcon(head.createSpan(), "alert-triangle");
    head.createSpan({ text });
    if (details) card.createEl("pre", { cls: "cc-pre", text: details.slice(-3000) });
    const settings = card.createEl("button", { cls: "cc-link-btn", text: "Open settings" });
    settings.onclick = () => this.openSettings();
    this.scrollDown(true);
  }

  private startText(key: string): TextBlock {
    const { body } = this.addItem("cc-text");
    const block: TextBlock = { el: body.createDiv({ cls: "cc-md markdown-rendered" }), buf: "", comp: null, timer: null, seq: 0 };
    this.texts.set(key, block);
    return block;
  }

  private appendText(key: string, delta: string) {
    const block = this.texts.get(key) ?? this.startText(key);
    block.buf += delta;
    if (block.timer === null) {
      block.timer = window.setTimeout(() => {
        block.timer = null;
        void this.renderMarkdown(block);
      }, 60);
    }
  }

  private finishText(key: string, text?: string) {
    const block = this.texts.get(key);
    if (!block) return;
    if (text !== undefined) block.buf = text;
    if (block.timer !== null) window.clearTimeout(block.timer);
    block.timer = null;
    if (!block.buf.trim()) {
      block.el.closest(".cc-item")?.remove();
      this.texts.delete(key);
      return;
    }
    void this.renderMarkdown(block);
  }

  private async renderMarkdown(block: TextBlock) {
    const seq = ++block.seq;
    const stick = this.nearBottom();
    const comp = this.addChild(new Component());
    const tmp = document.createElement("div");
    await MarkdownRenderer.render(this.app, block.buf, tmp, "", comp);
    if (seq !== block.seq) {
      this.removeChild(comp);
      return;
    }
    if (block.comp) this.removeChild(block.comp);
    block.comp = comp;
    block.el.replaceChildren(...Array.from(tmp.childNodes));
    if (stick) this.scrollDown();
  }

  private startThinking(key: string, text = ""): TextBlock {
    const { item, body } = this.addItem("cc-thinking");
    const head = body.createDiv({ cls: "cc-fold-head" });
    head.createSpan({ text: "Thinking" });
    setIcon(head.createSpan({ cls: "cc-chevron" }), "chevron-right");
    head.onclick = () => item.toggleClass("is-open", !item.hasClass("is-open"));
    const block: TextBlock = { el: body.createDiv({ cls: "cc-thinking-body" }), buf: text, comp: null, timer: null, seq: 0 };
    block.el.setText(text);
    this.thinking.set(key, block);
    return block;
  }

  // ---------------------------------------------------------------- tools

  private toolView(id: string, name: string, input: Input, parent?: HTMLElement): ToolView {
    let tv = this.tools.get(id);
    if (!tv) {
      const { item, body } = this.addItem("cc-tool is-running", parent);
      const head = body.createDiv({ cls: "cc-tool-head" });
      const verbEl = head.createSpan({ cls: "cc-tool-verb" });
      const targetEl = head.createSpan({ cls: "cc-tool-target" });
      const metaEl = head.createSpan({ cls: "cc-tool-meta" });
      setIcon(head.createSpan({ cls: "cc-chevron" }), "chevron-right");
      head.onclick = (e) => {
        if ((e.target as HTMLElement).closest(".cc-link")) return;
        item.toggleClass("is-open", !item.hasClass("is-open"));
      };
      tv = {
        name,
        input,
        item,
        verbEl,
        targetEl,
        metaEl,
        body: body.createDiv({ cls: "cc-tool-body" }),
        children: body.createDiv({ cls: "cc-tool-children" }),
        done: false,
        error: false,
      };
      this.tools.set(id, tv);
    }
    tv.name = name;
    tv.input = input;
    this.renderTool(tv);
    return tv;
  }

  private renderTool(tv: ToolView) {
    const { name, input } = tv;
    const summary = summarizeTool(name, input, this.vaultPath);
    tv.verbEl.setText(summary.verb);
    tv.targetEl.empty();
    const rel = summary.path ? this.vaultFile(summary.path) : null;
    if (rel) tv.targetEl.createSpan({ cls: "cc-link", text: summary.target, attr: { "data-path": rel.path } });
    else tv.targetEl.setText(summary.target);
    tv.targetEl.setAttr("aria-label", summary.target);

    const body = tv.body;
    body.empty();
    tv.metaEl.empty();
    const diff = EDIT_TOOLS.has(name) ? toolDiff(name, input) : null;
    if (diff?.length) {
      const { added, removed } = diffStats(diff);
      tv.metaEl.createSpan({ cls: "cc-add", text: `+${added}` });
      tv.metaEl.createSpan({ cls: "cc-del", text: `−${removed}` });
      renderDiff(body, diff);
      // While the permission card shows this diff, keep the row closed so the diff is not shown twice.
      if (tv.done && !tv.error) tv.item.addClass("is-open");
    } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
      renderTodos(body, input.todos as Todo[]);
      this.updatePinnedTodos(input.todos as Todo[]);
    } else if (name === "Bash" && input.command) {
      if (input.description) body.createDiv({ cls: "cc-tool-desc", text: String(input.description) });
      body.createEl("pre", { cls: "cc-pre cc-command", text: `$ ${input.command}` });
    } else if ((name === "Task" || name === "Agent") && input.prompt) {
      body.createDiv({ cls: "cc-tool-desc", text: String(input.prompt).slice(0, 800) });
    } else if (name === "ExitPlanMode" && input.plan) {
      void MarkdownRenderer.render(this.app, String(input.plan), body.createDiv({ cls: "cc-md markdown-rendered" }), "", this);
    } else if (Object.keys(input).length && !summary.path) {
      body.createEl("pre", { cls: "cc-pre", text: JSON.stringify(input, null, 2) });
    }

    if (tv.result !== undefined) {
      const showResult = tv.error || !(EDIT_TOOLS.has(name) || name === "TodoWrite" || name === "ExitPlanMode");
      if (name === "Read" && !tv.error) tv.metaEl.setText(`${tv.result.split("\n").length} lines`);
      if ((name === "Glob" || name === "Grep") && !tv.error && tv.result.trim()) {
        tv.metaEl.setText(`${tv.result.trim().split("\n").length} results`);
      }
      if (showResult && tv.result.trim()) {
        const text = tv.result.length > 4000 ? `${tv.result.slice(0, 4000)}\n…` : tv.result;
        body.createEl("pre", { cls: `cc-pre cc-result${tv.error ? " is-error" : ""}`, text });
      }
    }
    tv.item.toggleClass("has-body", body.childElementCount > 0 || tv.children.childElementCount > 0);
  }

  private completeTool(id: string, content: unknown, isError: boolean) {
    const tv = this.tools.get(id);
    if (!tv) return;
    tv.done = true;
    tv.error = isError;
    tv.result = resultText(content);
    tv.item.removeClass("is-running", "is-waiting");
    tv.item.addClass(isError ? "is-error" : "is-done");
    if (isError) tv.item.addClass("is-open");
    this.renderTool(tv);
  }

  private onToolResults(content: unknown) {
    if (!Array.isArray(content)) return;
    for (const block of content as Input[]) {
      if (block?.type === "tool_result") this.completeTool(block.tool_use_id, block.content, !!block.is_error);
    }
  }

  private updatePinnedTodos(todos: Todo[]) {
    this.uiTodos.empty();
    if (!todos.length) {
      this.uiTodos.addClass("is-hidden");
      return;
    }
    const done = todos.filter((t) => t.status === "completed").length;
    this.uiTodos.removeClass("is-hidden");
    const head = this.uiTodos.createDiv({ cls: "cc-fold-head" });
    head.createSpan({ text: `Todos ${done}/${todos.length}` });
    setIcon(head.createSpan({ cls: "cc-chevron" }), "chevron-right");
    head.onclick = () => this.uiTodos.toggleClass("is-open", !this.uiTodos.hasClass("is-open"));
    renderTodos(this.uiTodos, todos);
  }

  // ---------------------------------------------------------------- SDK stream

  private onMessage(m: SDKMessage) {
    const msg = m as any;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (msg.session_id) this.rememberSession(msg.session_id, this.convTitle);
          this.slashCommands = msg.slash_commands ?? [];
          void this.loadModels();
        } else if (msg.subtype === "compact_boundary") this.addNote("Conversation compacted");
        break;
      case "stream_event":
        this.onStream(msg);
        break;
      case "assistant":
        this.onAssistant(msg, false);
        break;
      case "user":
        this.onToolResults(msg.message?.content);
        break;
      case "result":
        this.onResult(msg);
        break;
    }
  }

  private onStream(m: any) {
    if (m.parent_tool_use_id) return;
    const ev = m.event;
    const key = `${this.currentMsgId}:${ev.index}`;
    switch (ev.type) {
      case "message_start":
        this.currentMsgId = ev.message.id;
        this.streamedIds.add(ev.message.id);
        this.ctxTokens = this.promptTokens(ev.message.usage) || this.ctxTokens;
        this.outputTokens += this.msgTokens;
        this.msgTokens = 0;
        if (!this.running) this.setRunning(true);
        break;
      case "content_block_start": {
        const cb = ev.content_block;
        if (cb.type === "text") this.startText(key);
        else if (cb.type === "thinking" && this.plugin.settings.showThinking) this.startThinking(key);
        else if (cb.type === "tool_use" && !HIDDEN_TOOLS.has(cb.name)) this.toolView(cb.id, cb.name, {});
        break;
      }
      case "content_block_delta":
        if (ev.delta.type === "text_delta") this.appendText(key, ev.delta.text);
        else if (ev.delta.type === "thinking_delta") {
          const t = this.thinking.get(key);
          if (t) {
            t.buf += ev.delta.thinking;
            t.el.setText(t.buf);
          }
        }
        break;
      case "content_block_stop": {
        if (this.texts.has(key)) this.finishText(key);
        const t = this.thinking.get(key);
        if (t && !t.buf.trim()) {
          t.el.closest(".cc-item")?.remove();
          this.thinking.delete(key);
        }
        break;
      }
      case "message_delta":
        if (ev.usage?.output_tokens) this.msgTokens = ev.usage.output_tokens;
        break;
    }
  }

  private onAssistant(m: any, replay: boolean) {
    const msg = m.message;
    if (!Array.isArray(msg?.content)) return;
    if (m.parent_tool_use_id) {
      const parent = this.tools.get(m.parent_tool_use_id);
      if (!parent) return;
      for (const b of msg.content) if (b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) this.toolView(b.id, b.name, b.input ?? {}, parent.children);
      parent.item.addClass("has-body");
      return;
    }
    const streamed = !replay && this.streamedIds.has(msg.id);
    msg.content.forEach((b: any, i: number) => {
      const key = `${msg.id}:full:${i}`;
      if (b.type === "text" && !streamed && b.text?.trim()) {
        this.startText(key);
        this.finishText(key, b.text);
      } else if (b.type === "thinking" && !streamed && this.plugin.settings.showThinking && b.thinking?.trim()) {
        this.startThinking(key, b.thinking);
      } else if (b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) {
        this.toolView(b.id, b.name, b.input ?? {});
      }
    });
    if (m.error && !replay) {
      const hint =
        m.error === "authentication_failed" ? "Claude Code is not logged in. Run `claude` in a terminal and log in, then try again." : `Claude Code reported: ${m.error}`;
      this.addError(hint);
    }
  }

  private onResult(m: any) {
    this.pending = Math.max(0, this.pending - 1);
    if (m.subtype !== "success") this.addError(m.errors?.join("\n") || `Claude stopped: ${m.subtype}`);
    else if (m.is_error && m.result) this.addError(String(m.result));
    if (this.pending === 0) {
      if (m.subtype === "success" && !m.is_error) this.uiMessages.createDiv({ cls: "cc-done", text: `Worked for ${formatDuration(Date.now() - this.turnStart)}` });
      this.setRunning(false);
    }
    const usage = Object.values((m.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)[0];
    this.updateContext(usage?.contextWindow);
  }

  private onSessionError(error: unknown, stderr: string) {
    this.pending = 0;
    this.setRunning(false);
    const message = error instanceof Error ? error.message : String(error);
    this.addError(message, stderr || undefined);
  }

  private onSessionExit() {
    if (this.running) {
      this.pending = 0;
      this.setRunning(false);
    }
  }

  private setRunning(on: boolean) {
    if (on && !this.running) {
      this.turnStart = Date.now();
      this.outputTokens = 0;
      this.msgTokens = 0;
      this.startSpinner();
    }
    if (!on) this.stopSpinner();
    this.running = on;
    if (!on) {
      for (const tv of this.tools.values()) {
        if (!tv.done && tv.item.hasClass("is-running")) tv.item.removeClass("is-running");
      }
    }
    this.updateSend();
  }

  private startSpinner() {
    this.stopSpinner();
    const el = this.uiWorking;
    el.empty();
    el.removeClass("is-hidden");
    const glyph = el.createSpan({ cls: "cc-spinner" });
    const label = el.createSpan({ cls: "cc-working-label", text: `${VERBS[Math.floor(Math.random() * VERBS.length)]}…` });
    const meta = el.createSpan({ cls: "cc-working-meta" });
    let frame = 0;
    const tick = () => {
      glyph.setText(SPINNER[frame++ % SPINNER.length]);
      const secs = Math.floor((Date.now() - this.turnStart) / 1000);
      const tokens = this.outputTokens + this.msgTokens;
      meta.setText(`${secs}s${tokens ? ` · ↓ ${fmtTokens(tokens)} tokens` : ""} · esc to interrupt`);
    };
    tick();
    label.setAttr("aria-live", "polite");
    this.spinTimer = window.setInterval(tick, 120);
    this.scrollDown();
  }

  private stopSpinner() {
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    this.spinTimer = null;
    this.uiWorking?.addClass("is-hidden");
  }

  // ---------------------------------------------------------------- permissions

  private canUseTool = async (toolName: string, input: Input, opts: PermissionOptions): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") return this.askQuestions(input, opts.signal);
    if (toolName === "ExitPlanMode") return this.reviewPlan(input, opts.signal);
    return this.askPermission(toolName, input, opts);
  };

  private card(cls: string, toolUseID?: string) {
    this.clearEmpty();
    const tv = toolUseID ? this.tools.get(toolUseID) : undefined;
    tv?.item.addClass("is-waiting");
    const card = this.uiMessages.createDiv({ cls: `cc-card ${cls}` });
    card.tabIndex = 0;
    if (!this.containerEl.isShown()) new Notice("Claude is waiting for your answer");
    window.setTimeout(() => {
      this.scrollDown(true);
      card.focus({ preventScroll: true });
    }, 0);
    let settled = false;
    const settle = (summary: string) => {
      if (settled) return false;
      settled = true;
      tv?.item.removeClass("is-waiting");
      card.empty();
      card.className = "cc-card is-resolved";
      card.setText(summary);
      this.uiInput.focus();
      return true;
    };
    return { card, settle };
  }

  private choices(card: HTMLElement, options: [string, () => void][], feedback?: (text: string) => void) {
    const list = card.createDiv({ cls: "cc-options" });
    options.forEach(([label, fn], i) => {
      const b = list.createEl("button", { cls: "cc-option" });
      b.createSpan({ cls: "cc-option-key", text: String(i + 1) });
      b.createSpan({ text: label });
      b.onclick = fn;
    });
    let input: HTMLInputElement | null = null;
    if (feedback) {
      input = list.createEl("input", { cls: "cc-option-input", attr: { type: "text", placeholder: "No, and tell Claude what to do differently…" } });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input!.value.trim()) {
          e.preventDefault();
          feedback(input!.value.trim());
        }
      });
    }
    card.addEventListener("keydown", (e) => {
      if (e.target === input) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        e.preventDefault();
        options[n - 1][1]();
      }
    });
  }

  private askPermission(toolName: string, input: Input, opts: PermissionOptions): Promise<PermissionResult> {
    const { card, settle } = this.card("cc-permission", opts.toolUseID);
    const summary = summarizeTool(toolName, input, this.vaultPath);
    const title = card.createDiv({ cls: "cc-card-title" });
    if (EDIT_TOOLS.has(toolName)) {
      title.appendText(`${toolName === "Write" ? "Create or overwrite" : "Edit"} `);
      title.createEl("code", { text: summary.target });
      title.appendText("?");
      const diff = toolDiff(toolName, input);
      if (diff?.length) renderDiff(card, diff, 200);
    } else if (toolName === "Bash") {
      title.setText("Allow Claude to run this command?");
      card.createEl("pre", { cls: "cc-pre cc-command", text: `$ ${input.command ?? ""}` });
      if (input.description) card.createDiv({ cls: "cc-tool-desc", text: String(input.description) });
    } else if (toolName === "WebFetch") {
      title.setText("Allow Claude to fetch this page?");
      card.createDiv({ cls: "cc-card-detail", text: String(input.url ?? "") });
    } else {
      title.setText(opts.title || `Allow Claude to use ${summary.verb}${summary.target ? ` on ${summary.target}` : ""}?`);
      if (Object.keys(input).length) card.createEl("pre", { cls: "cc-pre", text: JSON.stringify(input, null, 2).slice(0, 3000) });
    }
    if (opts.decisionReason) card.createDiv({ cls: "cc-card-reason", text: opts.decisionReason });

    return new Promise((resolve) => {
      const allow = (updatedPermissions?: PermissionUpdate[]) => {
        if (settle(`Allowed ${summary.verb}${summary.target ? ` ${summary.target}` : ""}`)) resolve({ behavior: "allow", updatedInput: input, updatedPermissions });
      };
      const deny = (message: string, interrupt: boolean, label: string) => {
        if (settle(label)) resolve({ behavior: "deny", message, interrupt });
      };
      const options: [string, () => void][] = [["Yes", () => allow()]];
      const suggestions = opts.suggestions;
      if (suggestions?.length) {
        options.push([
          this.alwaysLabel(toolName, suggestions),
          () => {
            const setMode = suggestions.find((s) => s.type === "setMode");
            if (setMode && setMode.type === "setMode") this.reflectMode(setMode.mode);
            allow(suggestions);
          },
        ]);
      }
      options.push(["No", () => deny("The user declined this action. Wait for further instructions.", true, `Declined ${summary.verb}`)]);
      this.choices(card, options, (text) => deny(text, false, `Declined ${summary.verb}: ${text}`));
      opts.signal.addEventListener("abort", () => deny("Cancelled", true, "Cancelled"), { once: true });
    });
  }

  private alwaysLabel(toolName: string, suggestions: PermissionUpdate[]): string {
    for (const s of suggestions) {
      if (s.type === "setMode" && s.mode === "acceptEdits") return "Yes, allow all edits this session";
      if (s.type === "addRules" && s.rules[0]?.ruleContent) return `Yes, and don't ask again for ${s.rules[0].toolName} ${s.rules[0].ruleContent}`;
      if (s.type === "addDirectories") return "Yes, and allow access to this folder";
    }
    return `Yes, and don't ask again for ${toolName} this session`;
  }

  private reviewPlan(input: Input, signal: AbortSignal): Promise<PermissionResult> {
    const { card, settle } = this.card("cc-plan");
    card.createDiv({ cls: "cc-card-title", text: "Ready to code? Here is Claude's plan:" });
    const md = card.createDiv({ cls: "cc-md markdown-rendered cc-plan-body" });
    void MarkdownRenderer.render(this.app, String(input.plan ?? ""), md, "", this);
    return new Promise((resolve) => {
      const approve = (mode: PermissionMode, label: string) => {
        if (!settle(label)) return;
        this.reflectMode(mode);
        resolve({ behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] });
      };
      const keep = (message: string, interrupt: boolean, label: string) => {
        if (settle(label)) resolve({ behavior: "deny", message, interrupt });
      };
      this.choices(
        card,
        [
          ["Yes, and edit automatically", () => approve("acceptEdits", "Plan approved, editing automatically")],
          ["Yes, and ask before edits", () => approve("default", "Plan approved, asking before edits")],
          ["No, keep planning", () => keep("The user wants to keep planning. Wait for their feedback.", true, "Kept planning")],
        ],
        (text) => keep(text, false, `Kept planning: ${text}`),
      );
      signal.addEventListener("abort", () => keep("Cancelled", true, "Cancelled"), { once: true });
    });
  }

  private askQuestions(input: Input, signal: AbortSignal): Promise<PermissionResult> {
    const { card, settle } = this.card("cc-question");
    const questions: Input[] = Array.isArray(input.questions) ? input.questions : [];
    const answers: Record<string, string> = {};
    return new Promise((resolve) => {
      const submit = () => {
        if (settle(`Answered: ${Object.values(answers).join("; ")}`)) resolve({ behavior: "allow", updatedInput: { ...input, answers } });
      };
      const submitBtn = createEl("button", { cls: "cc-option cc-submit mod-cta", text: "Submit" });
      const refresh = () => (submitBtn.disabled = questions.some((q) => !answers[q.question]));
      for (const q of questions) {
        const block = card.createDiv({ cls: "cc-q" });
        if (q.header) block.createSpan({ cls: "cc-q-header", text: String(q.header) });
        block.createDiv({ cls: "cc-card-title", text: String(q.question) });
        const picked = new Set<string>();
        const list = block.createDiv({ cls: "cc-options" });
        const buttons: HTMLButtonElement[] = [];
        for (const opt of q.options ?? []) {
          const b = list.createEl("button", { cls: "cc-option" });
          b.createSpan({ cls: "cc-option-label", text: String(opt.label) });
          if (opt.description) b.createSpan({ cls: "cc-option-desc", text: String(opt.description) });
          buttons.push(b);
          b.onclick = () => {
            if (q.multiSelect) {
              if (picked.has(opt.label)) picked.delete(opt.label);
              else picked.add(opt.label);
            } else {
              picked.clear();
              picked.add(opt.label);
            }
            buttons.forEach((x, i) => x.toggleClass("is-picked", picked.has(q.options[i].label)));
            answers[q.question] = [...picked].join(", ");
            refresh();
            if (!q.multiSelect && questions.length === 1) submit();
          };
        }
        const other = list.createEl("input", { cls: "cc-option-input", attr: { type: "text", placeholder: "Other…" } });
        other.addEventListener("input", () => {
          picked.clear();
          buttons.forEach((x) => x.removeClass("is-picked"));
          answers[q.question] = other.value.trim();
          refresh();
        });
        other.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !submitBtn.disabled) {
            e.preventDefault();
            submit();
          }
        });
      }
      const row = card.createDiv({ cls: "cc-card-actions" });
      row.appendChild(submitBtn);
      submitBtn.onclick = submit;
      const skip = row.createEl("button", { cls: "cc-option", text: "Skip" });
      skip.onclick = () => {
        if (settle("Skipped the questions")) resolve({ behavior: "deny", message: "The user skipped the questions.", interrupt: false });
      };
      refresh();
      signal.addEventListener("abort", () => {
        if (settle("Cancelled")) resolve({ behavior: "deny", message: "Cancelled", interrupt: true });
      });
    });
  }

  // ---------------------------------------------------------------- composer

  private autosize() {
    this.uiInput.setCssStyles({ height: "auto" });
    this.uiInput.setCssStyles({ height: `${Math.min(this.uiInput.scrollHeight, 260)}px` });
  }

  private updateSend() {
    if (!this.uiSend) return;
    const stop = this.running && !this.uiInput.value.trim() && !this.attachments.length;
    this.uiSend.empty();
    setIcon(this.uiSend, stop ? "square" : "arrow-up");
    this.uiSend.toggleClass("is-stop", stop);
    this.uiSend.disabled = !stop && !this.uiInput.value.trim() && !this.attachments.length;
    this.uiSend.setAttr("aria-label", stop ? "Stop (Esc)" : this.running ? "Queue message" : "Send (Enter)");
  }

  private onKey(e: KeyboardEvent) {
    if (!this.uiSuggest.hasClass("is-hidden") && this.suggestItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.suggestIdx = (this.suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + this.suggestItems.length) % this.suggestItems.length;
        this.renderSuggest();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.suggestItems[this.suggestIdx].apply();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideSuggest();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      this.cycleMode();
    } else if (e.key === "Escape" && this.running) {
      e.preventDefault();
      void this.session?.interrupt();
    } else if (e.key === "ArrowUp" && !this.uiInput.value && this.promptHistory.length) {
      e.preventDefault();
      this.uiInput.value = this.promptHistory[this.promptHistory.length - 1];
      this.autosize();
      this.updateSend();
    }
  }

  private async onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const data = Buffer.from(await f.arrayBuffer()).toString("base64");
      this.attachments.push({ name: f.name || "image.png", mediaType: f.type, data });
    }
    this.renderChips();
    this.updateSend();
  }

  insertText(text: string) {
    const el = this.uiInput;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.focus();
    this.autosize();
    this.updateSuggest();
    this.updateSend();
  }

  insertMention(ref: string) {
    const before = this.uiInput.value.slice(0, this.uiInput.selectionStart ?? 0);
    this.insertText(`${before && !/\s$/.test(before) ? " " : ""}@${quote(ref)} `);
  }

  private renderChips() {
    if (!this.uiChips) return;
    this.uiChips.empty();
    const file = this.lastMarkdown?.file;
    if (file && this.plugin.settings.includeActiveNote) {
      const chip = this.uiChips.createEl("button", { cls: `cc-chip${this.noteEnabled ? "" : " is-off"}` });
      setIcon(chip.createSpan({ cls: "cc-chip-icon" }), this.noteEnabled ? "file-text" : "eye-off");
      let label = file.basename;
      const editor = this.lastMarkdown?.editor;
      if (this.noteEnabled && editor?.somethingSelected()) {
        const from = editor.getCursor("from").line + 1;
        const to = editor.getCursor("to").line + 1;
        label += from === to ? `:${from}` : `:${from}-${to}`;
      }
      chip.createSpan({ text: label });
      chip.setAttr("aria-label", this.noteEnabled ? "Claude sees this note. Click to hide it." : "Hidden from Claude. Click to share.");
      chip.onclick = () => {
        this.noteEnabled = !this.noteEnabled;
        this.renderChips();
      };
    }
    this.attachments.forEach((a, i) => {
      const chip = this.uiChips.createDiv({ cls: "cc-chip" });
      chip.createEl("img", { cls: "cc-chip-thumb", attr: { src: `data:${a.mediaType};base64,${a.data}` } });
      chip.createSpan({ text: a.name });
      const x = chip.createSpan({ cls: "cc-chip-x" });
      setIcon(x, "x");
      x.onclick = () => {
        this.attachments.splice(i, 1);
        this.renderChips();
        this.updateSend();
      };
    });
    this.uiChips.toggleClass("is-hidden", !this.uiChips.childElementCount);
  }

  private buildContext(text: string): string {
    const parts: string[] = [];
    const view = this.lastMarkdown;
    if (this.noteEnabled && this.plugin.settings.includeActiveNote && view?.file) {
      parts.push(`The user has the note "${view.file.path}" open in Obsidian. Paths are relative to the vault root ${this.vaultPath}.`);
      const editor = view.editor;
      if (editor.somethingSelected()) {
        const from = editor.getCursor("from").line + 1;
        const to = editor.getCursor("to").line + 1;
        parts.push(`Selected lines ${from}-${to}:\n\`\`\`\n${editor.getSelection().slice(0, 20000)}\n\`\`\``);
      }
    }
    const mentions = this.resolveMentions(text);
    if (mentions.length) parts.push(`Notes the user mentioned with @ (relative to ${this.vaultPath}): ${mentions.join(", ")}`);
    return parts.length ? `<obsidian_context>\n${parts.join("\n\n")}\n</obsidian_context>` : "";
  }

  private resolveMentions(text: string): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(/@"([^"]+)"|@([^\s@"]+)/g)) {
      const raw = m[1] ?? m[2];
      const [rawPath, lines] = raw.split("#");
      const path = normalizePath(rawPath);
      const file = this.app.vault.getAbstractFileByPath(path) ?? this.app.metadataCache.getFirstLinkpathDest(path, "");
      if (file) found.add(lines ? `${file.path}#${lines}` : file.path);
    }
    return [...found];
  }

  send(preset?: string) {
    const text = (preset ?? this.uiInput.value).trim();
    if (!text && !this.attachments.length) return;
    if (text === "/clear" || text === "/new") {
      this.uiInput.value = "";
      this.newConversation();
      return;
    }
    if (text === "/resume") {
      this.uiInput.value = "";
      this.autosize();
      void this.showHistory();
      return;
    }
    this.promptHistory.push(text);
    this.uiInput.value = "";
    this.autosize();
    this.hideSuggest();

    const extras: string[] = [];
    let content: UserContent;
    if (text.startsWith("/")) {
      content = text;
    } else {
      const blocks: Exclude<UserContent, string> = [{ type: "text", text }];
      const ctx = this.buildContext(text);
      if (ctx) {
        blocks.push({ type: "text", text: ctx });
        const file = this.lastMarkdown?.file;
        if (this.noteEnabled && file) extras.push(file.basename);
      }
      for (const a of this.attachments) {
        blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType as "image/png", data: a.data } });
        extras.push(a.name);
      }
      content = blocks;
    }
    this.attachments = [];
    this.renderChips();
    if (!this.convTitle) this.setTitle(text);
    if (this.uiTodos.querySelectorAll(".cc-todo:not(.is-completed)").length === 0) this.uiTodos.addClass("is-hidden");
    this.addUser(text, extras);
    void this.ensureSession().then((session) => {
      if (!session) return;
      this.pending++;
      this.setRunning(true);
      session.send(content);
    });
    this.updateSend();
  }

  private async ensureSession(): Promise<ClaudeSession | null> {
    if (this.session) return this.session;
    const shell = await loadShellEnv();
    const claude = findClaude(shell, this.plugin.settings.claudePath);
    if (!claude) {
      this.addError("Claude Code CLI not found. Install it with `brew install --cask claude-code` or set its path in settings.");
      return null;
    }
    this.session = new ClaudeSession({
      cwd: this.vaultPath,
      claudePath: claude,
      env: buildEnv(shell, this.plugin.settings.proxy, this.plugin.manifest.version),
      model: this.model === "default" ? undefined : this.model,
      permissionMode: this.mode,
      resume: this.resumeId ?? undefined,
      showThinking: this.plugin.settings.showThinking,
      appendSystemPrompt: SYSTEM_APPEND,
      canUseTool: this.canUseTool,
      onMessage: (m) => this.onMessage(m),
      onError: (err, stderr) => this.onSessionError(err, stderr),
      onExit: () => this.onSessionExit(),
    });
    return this.session;
  }

  newConversation() {
    this.session?.close();
    this.session = null;
    this.resumeId = null;
    this.pending = 0;
    this.setRunning(false);
    for (const block of [...this.texts.values(), ...this.thinking.values()]) if (block.comp) this.removeChild(block.comp);
    this.tools.clear();
    this.texts.clear();
    this.thinking.clear();
    this.streamedIds.clear();
    this.ctxTokens = 0;
    this.uiCtx.empty();
    this.uiTodos.empty();
    this.uiTodos.addClass("is-hidden");
    this.uiHistory.addClass("is-hidden");
    this.uiMessages.empty();
    this.setTitle("");
    this.rememberSession("", "");
    this.renderEmpty();
    this.focusInput();
  }

  // ---------------------------------------------------------------- suggestions

  private updateSuggest() {
    const pos = this.uiInput.selectionStart ?? 0;
    const before = this.uiInput.value.slice(0, pos);
    const at = /(^|\s)@"?([^\s"@]*)$/.exec(before);
    if (at) {
      const start = before.length - at[0].length + at[1].length;
      const files = this.matchFiles(at[2]);
      this.suggestItems = files.map((f) => ({
        label: f.extension === "md" ? f.basename : f.name,
        detail: f.parent && f.parent.path !== "/" ? f.parent.path : "",
        icon: f.extension === "md" ? "file-text" : "file",
        apply: () => this.replaceRange(start, pos, `@${quote(f.path)} `),
      }));
    } else if (/^\/[\w:-]*$/.test(before)) {
      const q = before.slice(1).toLowerCase();
      const commands = [...new Set(["clear", "resume", "compact", ...this.slashCommands])].filter((c) => c.toLowerCase().startsWith(q)).slice(0, 10);
      this.suggestItems = commands.map((c) => ({
        label: `/${c}`,
        detail: c === "clear" ? "Start a new conversation" : c === "resume" ? "Resume a past conversation" : "",
        apply: () => this.replaceRange(0, pos, `/${c} `),
      }));
    } else {
      this.suggestItems = [];
    }
    this.suggestIdx = 0;
    this.renderSuggest();
  }

  private matchFiles(query: string): TFile[] {
    if (!query) {
      return this.app.workspace
        .getLastOpenFiles()
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile)
        .slice(0, 8);
    }
    const fuzzy = prepareFuzzySearch(query);
    return this.app.vault
      .getFiles()
      .map((f) => ({ f, r: fuzzy(f.path) }))
      .filter((x) => x.r)
      .sort((a, b) => b.r!.score - a.r!.score)
      .slice(0, 8)
      .map((x) => x.f);
  }

  private replaceRange(start: number, end: number, text: string) {
    const v = this.uiInput.value;
    this.uiInput.value = v.slice(0, start) + text + v.slice(end);
    this.uiInput.selectionStart = this.uiInput.selectionEnd = start + text.length;
    this.uiInput.focus();
    this.hideSuggest();
    this.autosize();
    this.updateSend();
  }

  private renderSuggest() {
    this.uiSuggest.empty();
    if (!this.suggestItems.length) {
      this.uiSuggest.addClass("is-hidden");
      return;
    }
    this.uiSuggest.removeClass("is-hidden");
    this.suggestItems.forEach((item, i) => {
      const row = this.uiSuggest.createDiv({ cls: `cc-suggest-item${i === this.suggestIdx ? " is-selected" : ""}` });
      if (item.icon) setIcon(row.createSpan({ cls: "cc-suggest-icon" }), item.icon);
      row.createSpan({ cls: "cc-suggest-label", text: item.label });
      if (item.detail) row.createSpan({ cls: "cc-suggest-detail", text: item.detail });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        item.apply();
      });
    });
  }

  private hideSuggest() {
    this.suggestItems = [];
    this.uiSuggest?.addClass("is-hidden");
  }

  // ---------------------------------------------------------------- mode, model, context

  private modeMenu(e: MouseEvent) {
    const menu = new Menu();
    for (const m of MODES) menu.addItem((i) => i.setTitle(m.label).setIcon(m.icon).setChecked(m.id === this.mode).onClick(() => void this.setMode(m.id)));
    menu.showAtMouseEvent(e);
  }

  private cycleMode() {
    const i = MODES.findIndex((m) => m.id === this.mode);
    void this.setMode(MODES[(i + 1) % MODES.length].id);
  }

  private async setMode(mode: PermissionMode) {
    this.reflectMode(mode);
    await this.session?.setPermissionMode(mode);
  }

  /** Mode changed by Claude Code itself (plan approval, "allow all edits"). */
  private reflectMode(mode: PermissionMode) {
    this.mode = mode;
    if (this.session) this.session.permissionMode = mode;
    this.updateModeBtn();
  }

  private updateModeBtn() {
    const m = MODES.find((x) => x.id === this.mode) ?? { label: this.mode, icon: "shield" };
    this.uiModeBtn.empty();
    setIcon(this.uiModeBtn.createSpan({ cls: "cc-pill-icon" }), m.icon);
    this.uiModeBtn.createSpan({ text: m.label });
    this.uiModeBtn.toggleClass("is-accent", this.mode !== "default");
  }

  private modelMenu(e: MouseEvent) {
    const menu = new Menu();
    for (const m of this.models) {
      menu.addItem((i) =>
        i
          .setTitle(m.description ? `${m.displayName} · ${m.description}` : m.displayName)
          .setChecked(m.value === this.model)
          .onClick(async () => {
            this.model = m.value;
            this.updateModelBtn();
            await this.session?.setModel(m.value === "default" ? undefined : m.value);
          }),
      );
    }
    menu.showAtMouseEvent(e);
  }

  private async loadModels() {
    const list = await this.session?.supportedModels();
    if (list?.length) this.models = list;
    this.updateModelBtn();
  }

  private updateModelBtn() {
    const m = this.models.find((x) => x.value === this.model);
    this.uiModelBtn.empty();
    this.uiModelBtn.createSpan({ text: m?.displayName ?? this.model });
    setIcon(this.uiModelBtn.createSpan({ cls: "cc-pill-icon" }), "chevron-down");
  }

  private promptTokens(usage: any): number {
    if (!usage) return 0;
    return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  }

  private updateContext(window?: number) {
    this.uiCtx.empty();
    if (!window || !this.ctxTokens) return;
    const pct = (this.ctxTokens / window) * 100;
    this.uiCtx.setText(`${Math.max(1, Math.round(pct))}% context`);
    this.uiCtx.toggleClass("is-warn", pct >= 80);
    this.uiCtx.setAttr("aria-label", "Context window used. Claude compacts automatically, or run /compact.");
  }

  // ---------------------------------------------------------------- history

  private async toggleHistory() {
    if (!this.uiHistory.hasClass("is-hidden")) this.uiHistory.addClass("is-hidden");
    else await this.showHistory();
  }

  async showHistory() {
    const el = this.uiHistory;
    el.empty();
    el.removeClass("is-hidden");
    const head = el.createDiv({ cls: "cc-history-head" });
    const search = head.createEl("input", { cls: "cc-history-search", attr: { type: "search", placeholder: "Search conversations" } });
    this.iconButton(head, "x", "Close", () => el.addClass("is-hidden"));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        el.addClass("is-hidden");
        this.focusInput();
      }
    });
    const list = el.createDiv({ cls: "cc-history-list" });
    list.createDiv({ cls: "cc-history-empty", text: "Loading…" });
    search.focus();
    let sessions: SDKSessionInfo[];
    try {
      sessions = (await listSessions({ dir: this.vaultPath, limit: 200 })).sort((a, b) => b.lastModified - a.lastModified);
    } catch (e) {
      list.empty();
      list.createDiv({ cls: "cc-history-empty", text: `Could not load sessions: ${String(e)}` });
      return;
    }
    const current = this.session?.sessionId ?? this.resumeId;
    const render = () => {
      list.empty();
      const q = search.value.trim().toLowerCase();
      const shown = sessions.filter((s) => !q || sessionTitle(s).toLowerCase().includes(q));
      if (!shown.length) list.createDiv({ cls: "cc-history-empty", text: q ? "No matches" : "No conversations in this vault yet" });
      for (const s of shown) {
        const row = list.createDiv({ cls: `cc-history-item${s.sessionId === current ? " is-current" : ""}` });
        const title = sessionTitle(s);
        row.createDiv({ cls: "cc-history-title", text: title });
        row.createDiv({ cls: "cc-history-meta", text: [relativeTime(s.lastModified), s.gitBranch !== "HEAD" ? s.gitBranch : ""].filter(Boolean).join(" · ") });
        row.onclick = () => {
          el.addClass("is-hidden");
          void this.openSession(s.sessionId, title);
        };
      }
    };
    search.oninput = render;
    render();
  }

  private async openSession(id: string, title: string, quiet = false) {
    this.newConversation();
    let messages: Awaited<ReturnType<typeof getSessionMessages>>;
    try {
      messages = await getSessionMessages(id, { dir: this.vaultPath });
    } catch (e) {
      // A remembered conversation may have been deleted; start fresh instead of showing an error.
      if (!quiet) this.addError(`Could not load the conversation: ${String(e)}`);
      return;
    }
    if (!messages.length) {
      if (!quiet) this.addError("That conversation is empty or no longer exists.");
      return;
    }
    this.resumeId = id;
    this.setTitle(title);
    this.rememberSession(id, title);
    this.clearEmpty();
    for (const m of messages as any[]) {
      if (m.type === "assistant") {
        this.onAssistant(m, true);
        this.ctxTokens = this.promptTokens(m.message?.usage) || this.ctxTokens;
      }
      else if (m.type === "user") this.replayUser(m);
    }
    for (const tv of this.tools.values()) {
      tv.item.removeClass("is-running");
      if (!tv.done) tv.item.addClass("is-done");
    }
    this.addNote("Resumed. New messages continue this conversation.");
    this.renderEmpty();
    this.scrollDown(true);
  }

  private replayUser(m: any) {
    const content = m.message?.content;
    if (m.parent_tool_use_id) {
      this.onToolResults(content);
      return;
    }
    if (typeof content === "string") {
      const text = cleanUserText(content);
      if (text) this.addUser(text, []);
      return;
    }
    if (!Array.isArray(content)) return;
    this.onToolResults(content);
    const texts = content.filter((b: Input) => b.type === "text").map((b: Input) => cleanUserText(String(b.text))).filter(Boolean);
    const images = content.filter((b: Input) => b.type === "image").length;
    if (texts.length || images) this.addUser(texts.join("\n"), images ? [`${images} image${images > 1 ? "s" : ""}`] : []);
  }

  // ---------------------------------------------------------------- misc

  private moreMenu(e: MouseEvent) {
    const menu = new Menu();
    const id = this.session?.sessionId ?? this.resumeId;
    if (id) {
      menu.addItem((i) =>
        i
          .setTitle("Copy resume command")
          .setIcon("terminal")
          .onClick(() => {
            void navigator.clipboard.writeText(`cd ${quote(this.vaultPath)} && claude --resume ${id}`);
            new Notice("Copied. Paste it in a terminal to continue there.");
          }),
      );
    }
    menu.addItem((i) => i.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()));
    menu.showAtMouseEvent(e);
  }

  private openSettings() {
    const setting = (this.app as any).setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
  }

  private vaultFile(path: string): TFile | null {
    const base = this.vaultPath;
    const rel = path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
    const file = this.app.vault.getAbstractFileByPath(rel);
    return file instanceof TFile ? file : null;
  }

  private openFile(file: TFile) {
    const ws = this.app.workspace;
    const leaf = ws.getMostRecentLeaf(ws.rootSplit) ?? ws.getLeaf("tab");
    void leaf.openFile(file);
  }

  private onMessagesClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>(".cc-link");
    if (link?.dataset.path) {
      e.preventDefault();
      const file = this.app.vault.getAbstractFileByPath(link.dataset.path);
      if (file instanceof TFile) this.openFile(file);
      return;
    }
    const internal = target.closest<HTMLAnchorElement>("a.internal-link");
    if (internal) {
      e.preventDefault();
      const href = internal.getAttribute("data-href") ?? internal.getAttribute("href") ?? "";
      const file = this.app.metadataCache.getFirstLinkpathDest(href.split("#")[0], "");
      if (file) this.openFile(file);
    }
  }
}
