# Margin Agent

Margin Agent puts a Claude Code chat in the Obsidian sidebar. It runs the `claude` CLI you already have installed, with your vault as the working directory, and lays the conversation out like the Claude Code extension for VS Code: replies stream in as Markdown, each tool call gets its own row, edits show up as diffs, and Claude asks before it changes your notes.

Margin Agent is an independent project. Anthropic did not make it and does not endorse or support it.

## Features

- Replies stream as rendered Markdown. Summarized thinking appears as a collapsed block.
- Every tool call is a row you can expand to see the file that was read, the search, or the shell command and its output. Edits open as a line diff with added and removed counts.
- Before an edit or a command, a card asks for permission. You can allow it once, allow it for the rest of the session, decline, or type what Claude should do instead. Keys 1 to 3 choose an option.
- The permission modes from Claude Code are available: ask before edits, edit automatically, plan mode and auto mode. Shift+Tab cycles through them. In plan mode you read and approve the plan before any edit happens.
- When Claude asks a multiple-choice question, you answer it in the panel.
- Each message tells Claude which note is open and includes the lines you selected. Click the note chip above the prompt to stop sharing it.
- Typing `@` suggests notes to mention and `/` suggests commands, including your own commands and skills. Paste an image to attach it.
- The history lists every Claude Code conversation for this vault, including ones you started in a terminal, and continues any of them. The last conversation reopens when Obsidian starts.
- A counter under the prompt shows how much of the context window the conversation uses.

## Requirements

- Obsidian 1.7.2 or later on desktop. The plugin starts a local process, so it does not work on mobile. It has been tested on macOS only.
- Claude Code installed and signed in. If `claude` works in your terminal, the plugin can use it.

## Installation

The plugin is not in the community directory yet. To install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/vsaraikin/obsidian-margin-agent/releases/latest).
2. Copy them to `<your vault>/.obsidian/plugins/margin-agent/`.
3. In Obsidian, open Settings, then Community plugins, and enable Margin Agent.

With the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin you can add `vsaraikin/obsidian-margin-agent` instead and get updates automatically.

## Usage

Open the panel with the ribbon icon or the command "Margin Agent: Open chat". The other commands are New conversation, Resume last conversation, Browse conversation history, and Mention current note in the prompt.

| Key | Action |
| --- | --- |
| Enter | Send the message |
| Shift+Enter | New line |
| Shift+Tab | Switch to the next permission mode |
| Esc | Stop Claude |
| Up arrow in an empty prompt | Bring back the previous message |
| `@` | Mention a note |
| `/` | Run a command. `/clear` starts a new conversation and `/resume` opens the history. |

## Settings

| Setting | What it does |
| --- | --- |
| Claude Code executable | Path to the `claude` binary. Leave it empty to look it up on the PATH of your login shell. |
| HTTPS proxy | Passed to Claude Code as `HTTPS_PROXY` and `HTTP_PROXY`. On first run it is copied from your shell if you have one set. |
| Default model | The model a new conversation starts with. You can change it per conversation under the prompt. |
| Default permission mode | The mode a new conversation starts in. |
| Share the open note | Sends the open note's path and your selection with each message. |
| Reopen last conversation | Continues the last conversation when Obsidian starts. |
| Show thinking | Shows summarized reasoning as collapsed blocks. |

## How it works

The plugin uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) to start your installed `claude` binary and keeps one process running per conversation. Your CLAUDE.md files, settings, skills and MCP servers apply the same way they do in a terminal.

On macOS, Obsidian starts from the Dock and does not see your shell configuration. The plugin therefore runs your login shell once and reads `PATH` and any proxy variables from it.

Conversation history comes from the session files Claude Code keeps in `~/.claude/projects`, the same files `claude --resume` reads.

## Network, accounts and data

The plugin makes no network requests of its own and has no telemetry. Claude Code, which the plugin starts, sends your prompts to Anthropic's API, or to the provider you configured in Claude Code. That includes the open note's path, the text you selected, and any files or command output Claude reads while it works.

You need a Claude account or an Anthropic API key, set up in Claude Code itself. Anthropic bills your usage under your own plan. The plugin never sees or stores your credentials. Anthropic asks third-party tools built on the Agent SDK to use API key authentication, so read their [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) before you use a subscription login with this plugin.

The plugin reads files outside your vault in two places: Claude Code's session files in `~/.claude/projects`, to list and restore conversations, and your login shell's environment, once at startup. Claude Code works in the vault folder, but its tools can reach other paths. It follows your Claude Code permission settings and asks in the panel before edits and most commands.

## Building from source

```sh
npm install
npm run build                                # type check and bundle into dist/
OBSIDIAN_VAULT="/path/to/vault" npm run dev  # rebuild on change and copy into the vault
npm run test:view                            # render the panel in a simulated DOM
npm run smoke -- /tmp/some-empty-folder      # one real Claude Code turn; it creates hello.md there
```

`npm run smoke` runs a real conversation, so it counts against your Claude usage.

## License

The plugin's source code is released under the MIT license. The released `main.js` also contains the Claude Agent SDK, which belongs to Anthropic PBC and is covered by Anthropic's terms, not by the MIT license.
