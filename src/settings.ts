import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type AgentSidebarPlugin from "./main";

export interface AgentSidebarSettings {
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

export const DEFAULT_SETTINGS: AgentSidebarSettings = {
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

const MODEL_OPTIONS = { default: "Default (recommended)", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const MODE_OPTIONS = { default: "Ask before edits", acceptEdits: "Edit automatically", plan: "Plan mode", auto: "Auto mode" };

type SettingKey = keyof AgentSidebarSettings;

const asText = (v: unknown): string => (typeof v === "string" ? v : "");

export class AgentSidebarSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AgentSidebarPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    return [
      {
        name: "Claude executable",
        desc: "Path to the Claude CLI binary. Leave it empty to look it up through your login shell.",
        control: { type: "text", key: "claudePath", placeholder: "Found automatically" },
      },
      {
        name: "HTTPS proxy",
        desc: "Passed to the Claude CLI for HTTPS and HTTP requests. Copied from your shell on first run.",
        control: { type: "text", key: "proxy", placeholder: "Proxy address" },
      },
      { name: "Default model", control: { type: "dropdown", key: "model", options: MODEL_OPTIONS } },
      {
        name: "Default permission mode",
        desc: "Mode a new conversation starts in. Shift+Tab in the prompt box switches it.",
        control: { type: "dropdown", key: "permissionMode", options: MODE_OPTIONS },
      },
      {
        name: "Share the open note",
        desc: "Tell Claude which note is open and pass the selected text with each message.",
        control: { type: "toggle", key: "includeActiveNote" },
      },
      {
        name: "Reopen last conversation",
        desc: "When Obsidian starts, the panel continues the conversation that was open in it.",
        control: { type: "toggle", key: "restoreLastConversation" },
      },
      {
        name: "Show thinking",
        desc: "Show summarized reasoning as collapsed blocks. Applies to new conversations.",
        control: { type: "toggle", key: "showThinking" },
      },
    ];
  }

  /** Obsidian before 1.13 does not read getSettingDefinitions(), so draw the same settings by hand. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings as unknown as Record<SettingKey, unknown>;
    const save = async (key: SettingKey, value: unknown) => {
      settings[key] = value;
      await this.plugin.saveSettings();
    };
    for (const def of this.getSettingDefinitions()) {
      if (!("control" in def) || !def.control) continue;
      const setting = new Setting(containerEl).setName(def.name);
      if (def.desc) setting.setDesc(def.desc);
      const control = def.control;
      if (control.type === "toggle") {
        setting.addToggle((t) => t.setValue(settings[control.key] === true).onChange((v) => save(control.key, v)));
      } else if (control.type === "dropdown") {
        setting.addDropdown((d) => d.addOptions(control.options).setValue(asText(settings[control.key])).onChange((v) => save(control.key, v)));
      } else if (control.type === "text") {
        setting.addText((t) =>
          t
            .setPlaceholder(control.placeholder ?? "")
            .setValue(asText(settings[control.key]))
            .onChange((v) => save(control.key, v.trim())),
        );
      }
    }
  }
}
