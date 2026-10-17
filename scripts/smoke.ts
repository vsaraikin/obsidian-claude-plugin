// Runs the same session code the plugin uses, outside Obsidian.
import { buildEnv, detectProxy, findClaude, loadShellEnv } from "../src/env";
import { ClaudeSession } from "../src/session";

void (async () => {
const cwd = process.argv[2] ?? process.cwd();
const seen = new Map<string, number>();
const shell = await loadShellEnv();
const claude = findClaude(shell, "");
if (!claude) throw new Error("claude not found");
console.log("claude:", claude, "proxy:", detectProxy(shell) || "(none)");

let resolveDone: () => void;
const done = new Promise<void>((r) => (resolveDone = r));
const session = new ClaudeSession({
  cwd,
  claudePath: claude,
  env: buildEnv(shell, detectProxy(shell), "smoke"),
  permissionMode: "default",
  showThinking: true,
  appendSystemPrompt: "",
  canUseTool: async (name, input) => {
    console.log("canUseTool:", name, JSON.stringify(input).slice(0, 120));
    return { behavior: "allow", updatedInput: input };
  },
  onMessage: (m: any) => {
    const k = m.type === "stream_event" ? `stream:${m.event.type}` : `${m.type}${m.subtype ? ":" + m.subtype : ""}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (m.type === "assistant") for (const b of m.message.content) console.log("assistant block:", b.type, b.type === "text" ? JSON.stringify(b.text) : b.name ?? "");
    if (m.type === "system" && m.subtype === "init") console.log("init model:", m.model, "mode:", m.permissionMode, "cmds:", m.slash_commands?.length);
    if (m.type === "result") {
      console.log("result:", m.subtype, m.is_error, m.duration_ms + "ms");
      resolveDone();
    }
  },
  onError: (e, stderr) => {
    console.error("ERROR", e, stderr);
    resolveDone();
  },
  onExit: () => console.log("exit"),
});
session.send([{ type: "text", text: "Create a file named hello.md in the current directory containing the single word ok. Then reply done." }]);
await done;
console.log("models:", (await session.supportedModels()).map((m) => m.value).join(", "));

session.close();
console.log("events:", Object.fromEntries(seen));
})();
