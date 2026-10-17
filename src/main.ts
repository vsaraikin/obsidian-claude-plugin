import { addIcon, MarkdownView, Plugin } from "obsidian";
import { detectProxy, loadShellEnv } from "./env";
import { ClaudeCodeSettingTab, DEFAULT_SETTINGS, type ClaudeCodeSettings } from "./settings";
import { ChatView, VIEW_TYPE } from "./view";

// A note with a margin column: text lines on the left, the agent's column on the right.
const ICON = `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
<rect x="12" y="14" width="76" height="72" rx="12"/><path d="M64 14v72"/><path d="M26 36h24M26 50h24M26 64h14"/>
<path d="M76 34v10M76 56v10" stroke-width="7"/></g>`;

export default class MarginAgentPlugin extends Plugin {
  settings: ClaudeCodeSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    addIcon("margin-agent", ICON);

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("margin-agent", "Open Margin Agent", () => void this.activateView());
    this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));

    this.addCommand({ id: "open", name: "Open chat", callback: () => void this.activateView() });
    this.addCommand({
      id: "new-conversation",
      name: "New conversation",
      callback: async () => (await this.activateView()).newConversation(),
    });
    this.addCommand({
      id: "resume-last",
      name: "Resume last conversation",
      callback: async () => (await this.activateView()).resumeLast(),
    });
    this.addCommand({
      id: "history",
      name: "Browse conversation history",
      callback: async () => (await this.activateView()).showHistory(),
    });
    this.addCommand({
      id: "mention-selection",
      name: "Mention current note in the prompt",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) {
          const editor = view.editor;
          const from = editor.getCursor("from").line + 1;
          const to = editor.getCursor("to").line + 1;
          const file = view.file;
          const ref = editor.somethingSelected() ? `${file.path}#L${from}${to !== from ? `-${to}` : ""}` : file.path;
          void this.activateView().then((chat) => chat.insertMention(ref));
        }
        return true;
      },
    });

    this.app.workspace.onLayoutReady(async () => {
      const env = await loadShellEnv();
      if (!this.settings.proxyDetected) {
        this.settings.proxy ||= detectProxy(env);
        this.settings.proxyDetected = true;
        await this.saveSettings();
      }
    });
  }

  async activateView(): Promise<ChatView> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("split");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    const view = leaf.view as ChatView;
    view.focusInput();
    return view;
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ClaudeCodeSettings> | null) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
