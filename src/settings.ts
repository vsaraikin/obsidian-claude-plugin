import { App, PluginSettingTab, Setting } from "obsidian";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type AgentSidebarPlugin from "./main";
import { findClaude, loadShellEnv } from "./env";

export interface ClaudeCodeSettings {
  claudePath: string;
  proxy: string;
  proxyDetected: boolean;
  model: string;
  permissionMode: PermissionMode;
  includeActiveNote: boolean;
  showThinking: boolean;
  restoreLastConversation: boolean;
  lastSessionId: string;
  lastSessionTitle: string;
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
  claudePath: "",
  proxy: "",
  proxyDetected: false,
  model: "default",
  permissionMode: "default",
  includeActiveNote: true,
  showThinking: true,
  restoreLastConversation: true,
  lastSessionId: "",
  lastSessionTitle: "",
};

export class ClaudeCodeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AgentSidebarPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    const pathSetting = new Setting(containerEl)
      .setName("Claude Code executable")
      .setDesc("Path to the claude binary. Leave empty to find it on your login shell PATH.")
      .addText((t) =>
        t.setValue(s.claudePath).onChange(async (v) => {
          s.claudePath = v.trim();
          await save();
        }),
      );
    void loadShellEnv().then((env) => {
      const found = findClaude(env, "");
      pathSetting.controlEl.querySelector("input")?.setAttribute("placeholder", found ?? "not found on PATH");
    });

    new Setting(containerEl)
      .setName("HTTPS proxy")
      .setDesc("Sent to Claude Code as HTTPS_PROXY and HTTP_PROXY. Filled in from your shell on first run.")
      .addText((t) =>
        t
          .setPlaceholder("http://host:port")
          .setValue(s.proxy)
          .onChange(async (v) => {
            s.proxy = v.trim();
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Default model")
      .addDropdown((d) =>
        d
          .addOptions({ default: "Default (recommended)", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" })
          .setValue(s.model)
          .onChange(async (v) => {
            s.model = v;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Default permission mode")
      .setDesc("Mode a new conversation starts in. Shift+Tab in the prompt box switches it.")
      .addDropdown((d) =>
        d
          .addOptions({ default: "Ask before edits", acceptEdits: "Edit automatically", plan: "Plan mode", auto: "Auto mode" })
          .setValue(s.permissionMode)
          .onChange(async (v) => {
            s.permissionMode = v as PermissionMode;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Share the open note")
      .setDesc("Tell Claude which note is open and pass the selected text with each message.")
      .addToggle((t) =>
        t.setValue(s.includeActiveNote).onChange(async (v) => {
          s.includeActiveNote = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Reopen last conversation")
      .setDesc("When Obsidian starts, the panel continues the conversation that was open in it.")
      .addToggle((t) =>
        t.setValue(s.restoreLastConversation).onChange(async (v) => {
          s.restoreLastConversation = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Show thinking")
      .setDesc("Show summarized reasoning as collapsed blocks. Applies to new conversations.")
      .addToggle((t) =>
        t.setValue(s.showThinking).onChange(async (v) => {
          s.showThinking = v;
          await save();
        }),
      );
  }
}
