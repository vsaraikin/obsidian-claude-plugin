// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Input = Record<string, any>;

export interface ToolSummary {
  verb: string;
  target: string;
  /** Absolute path when the tool works on one file. */
  path?: string;
}

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function relPath(path: string, base: string): string {
  if (!path) return "";
  if (path === base) return ".";
  return path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const firstLine = (s: string): string => {
  const line = s.split("\n")[0];
  return s.includes("\n") ? `${line} …` : line;
};

export function summarizeTool(name: string, input: Input, base: string): ToolSummary {
  const file = (key: string) => ({ target: relPath(str(input[key]), base), path: str(input[key]) || undefined });
  switch (name) {
    case "Read":
      return { verb: "Read", ...file("file_path") };
    case "Write":
      return { verb: "Write", ...file("file_path") };
    case "Edit":
    case "MultiEdit":
      return { verb: "Edit", ...file("file_path") };
    case "NotebookEdit":
      return { verb: "Edit", ...file("notebook_path") };
    case "Bash":
      return { verb: "Bash", target: firstLine(str(input.command)) };
    case "Glob":
      return { verb: "Glob", target: str(input.pattern) + (input.path ? ` in ${relPath(str(input.path), base)}` : "") };
    case "Grep":
      return {
        verb: "Grep",
        target: `"${str(input.pattern)}"` + (input.glob ? ` ${str(input.glob)}` : "") + (input.path ? ` in ${relPath(str(input.path), base)}` : ""),
      };
    case "WebFetch":
      return { verb: "Fetch", target: str(input.url) };
    case "WebSearch":
      return { verb: "Web search", target: `"${str(input.query)}"` };
    case "Task":
    case "Agent":
      return { verb: str(input.subagent_type) || "Agent", target: str(input.description) };
    case "TodoWrite":
      return { verb: "Update todos", target: "" };
    case "ExitPlanMode":
      return { verb: "Plan", target: "" };
    case "AskUserQuestion":
      return { verb: "Question", target: "" };
    case "Skill":
      return { verb: "Skill", target: str(input.skill) };
    default: {
      if (name.startsWith("mcp__")) {
        const [, server, ...tool] = name.split("__");
        return { verb: tool.join("__") || name, target: server };
      }
      const json = JSON.stringify(input);
      return { verb: name, target: json === "{}" ? "" : json.length > 80 ? json.slice(0, 80) + "…" : json };
    }
  }
}

export interface DiffLine {
  kind: " " | "+" | "-" | "…";
  text: string;
}

/** Line-level LCS diff, with long unchanged runs folded to three lines of context. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const out: DiffLine[] = [];
  if (a.length * b.length > 400_000) {
    for (const t of a) out.push({ kind: "-", text: t });
    for (const t of b) out.push({ kind: "+", text: t });
    return out;
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "-", text: a[i++] });
    else out.push({ kind: "+", text: b[j++] });
  }
  while (i < n) out.push({ kind: "-", text: a[i++] });
  while (j < m) out.push({ kind: "+", text: b[j++] });
  return fold(out, 3);
}

function fold(lines: DiffLine[], context: number): DiffLine[] {
  const keep = lines.map(() => false);
  lines.forEach((l, idx) => {
    if (l.kind === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) out.push({ kind: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

/** Diff for an edit-type tool input, or null when the input has nothing to compare. */
export function toolDiff(name: string, input: Input): DiffLine[] | null {
  if (name === "Edit") return lineDiff(str(input.old_string), str(input.new_string));
  if (name === "Write") return lineDiff("", str(input.content));
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const out: DiffLine[] = [];
    input.edits.forEach((e: Input, idx: number) => {
      if (idx) out.push({ kind: "…", text: "" });
      out.push(...lineDiff(str(e.old_string), str(e.new_string)));
    });
    return out;
  }
  if (name === "NotebookEdit") return lineDiff("", str(input.new_source));
  return null;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "+") added++;
    else if (l.kind === "-") removed++;
  }
  return { added, removed };
}

export function renderDiff(parent: HTMLElement, lines: DiffLine[], limit = 400): void {
  const box = parent.createDiv({ cls: "cc-diff" });
  for (const line of lines.slice(0, limit)) {
    const row = box.createDiv({ cls: "cc-diff-line" });
    if (line.kind === "+") row.addClass("is-add");
    else if (line.kind === "-") row.addClass("is-del");
    else if (line.kind === "…") row.addClass("is-fold");
    row.createSpan({ cls: "cc-diff-sign", text: line.kind === "…" ? "" : line.kind });
    row.createSpan({ cls: "cc-diff-text", text: line.text || " " });
  }
  if (lines.length > limit) box.createDiv({ cls: "cc-diff-line is-fold", text: `${lines.length - limit} more lines` });
}

/** Plain text of a tool_result content field. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
  return content
    .map((block: Input) => (block?.type === "text" ? str(block.text) : block?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function renderTodos(parent: HTMLElement, todos: Todo[]): void {
  const list = parent.createDiv({ cls: "cc-todo-list" });
  for (const todo of todos) {
    const row = list.createDiv({ cls: `cc-todo is-${todo.status}` });
    row.createSpan({ cls: "cc-todo-box" });
    row.createSpan({ cls: "cc-todo-text", text: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content });
  }
}

export function relativeTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
