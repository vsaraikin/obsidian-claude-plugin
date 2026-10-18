// Builds the chat view in happy-dom with Obsidian's DOM helpers emulated, to catch runtime errors in onOpen.
const { Window } = require("happy-dom");
const Module = require("module");
const win = new Window();
for (const k of ["document", "HTMLElement", "Node", "navigator", "KeyboardEvent", "MouseEvent"]) globalThis[k] = win[k];
globalThis.window = win;
const P = win.HTMLElement.prototype;
const make = (parent, tag, o = {}) => {
  if (typeof o === "string") o = { cls: o };
  const el = win.document.createElement(tag);
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text) el.textContent = o.text;
  for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
};
P.createEl = function (tag, o, cb) { const el = make(this, tag, o); cb?.(el); return el; };
P.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
P.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
P.empty = function () { this.replaceChildren(); };
P.setText = function (t) { this.textContent = t; };
P.appendText = function (t) { this.append(t); };
P.addClass = function (...c) { this.classList.add(...c); };
P.removeClass = function (...c) { this.classList.remove(...c); };
P.toggleClass = function (c, v) { this.classList.toggle(c, v); };
P.hasClass = function (c) { return this.classList.contains(c); };
P.setAttr = function (k, v) { this.setAttribute(k, v); };
P.isShown = function () { return true; };
P.setCssStyles = function (styles) { Object.assign(this.style, styles); };
globalThis.createEl = (tag, o) => make(null, tag, o);
globalThis.createDiv = (o) => make(null, "div", o);

class Component { addChild(c) { return c; } removeChild() {} registerDomEvent(el, ev, fn) { el.addEventListener(ev, fn); } registerEvent() {} register() {} }
class ItemView extends Component {
  constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = make(null, "div"); this.titleEl = make(this.containerEl, "div"); this.contentEl = make(this.containerEl, "div"); }
}
const obsidian = {
  Component, ItemView, Plugin: class {}, PluginSettingTab: class {}, Setting: class {},
  MarkdownView: class {}, FileSystemAdapter: class { getBasePath() { return "/vault"; } }, TFile: class {},
  Menu: class { addItem() { return this; } showAtMouseEvent() {} }, Notice: class {},
  MarkdownRenderer: { render: async (app, md, el) => { el.textContent = md; } },
  setIcon: (el, name) => el.setAttribute("data-icon", name), addIcon() {}, prepareFuzzySearch: () => () => null,
  normalizePath: (p) => p,
};
const orig = Module._load;
Module._load = function (req, ...rest) { return req === "obsidian" ? obsidian : orig.call(this, req, ...rest); };

const { ChatView } = require(require("path").resolve(process.argv[2]));
const app = {
  vault: { adapter: new obsidian.FileSystemAdapter(), getFiles: () => [], getAbstractFileByPath: () => null },
  workspace: { getActiveViewOfType: () => null, getMostRecentLeaf: () => null, rootSplit: {}, on: () => ({}), getLastOpenFiles: () => [] },
  metadataCache: { getFirstLinkpathDest: () => null },
};
const plugin = {
  settings: { claudePath: "", proxy: "", model: "default", permissionMode: "default", includeActiveNote: true, showThinking: true, restoreLastConversation: false, lastSessionId: "", lastSessionTitle: "" },
  manifest: { id: "agent-sidebar", version: "0.1.0" },
  saveSettings: async () => {},
};
const view = new ChatView({ app }, plugin);
(async () => {
  await view.onOpen();
  console.log("obsidian titleEl intact:", !!view.titleEl);
  const root = view.contentEl;
  for (const sel of [".cc-header", ".cc-title", ".cc-empty", ".cc-starter", ".cc-input", ".cc-pill", ".cc-send"]) console.log(sel, root.querySelectorAll(sel).length);
  console.log("mode pill:", root.querySelector(".cc-pill").textContent, "| model pill:", root.querySelectorAll(".cc-pill")[1].textContent);
  // Feed a scripted turn through the renderer.
  view.addUser("hi", ["Note"]);
  const s = (event) => view.onMessage({ type: "stream_event", parent_tool_use_id: null, event });
  s({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5000 } } });
  s({ type: "content_block_start", index: 0, content_block: { type: "text" } });
  s({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello **there**" } });
  s({ type: "content_block_stop", index: 0 });
  s({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Edit" } });
  view.onMessage({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/vault/a.md", old_string: "a\nb\nc", new_string: "a\nB\nc" } }] } });
  view.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  view.onMessage({ type: "result", subtype: "success", is_error: false, modelUsage: { x: { contextWindow: 200000 } } });
  await new Promise((r) => setTimeout(r, 100));
  console.log("items:", root.querySelectorAll(".cc-item").length, "| diff lines:", root.querySelectorAll(".cc-diff-line").length, "| stats:", root.querySelector(".cc-tool-meta").textContent, "| done:", root.querySelector(".cc-done")?.textContent, "| ctx:", root.querySelector(".cc-ctx").textContent);
  view.newConversation();
  console.log("after new conversation, empty state:", root.querySelectorAll(".cc-empty").length);
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
