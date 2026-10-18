# Changelog

## 0.1.4

- Dependencies install with a plain `npm ci` again, so the directory's source review and build verification can run.
- Release assets come with GitHub build provenance attestations.
- Styles no longer use `!important`.
- The README describes in more detail what the plugin reads outside the vault.

## 0.1.3

- Settings use Obsidian's declarative settings API on 1.13 and later, so they show up in settings search. Older versions get the same settings drawn by hand.
- The code passes the official `eslint-plugin-obsidianmd` rules, and the release workflow runs them before every build.
- UI text follows Obsidian's sentence case.

## 0.1.2

- Renamed to Agent Sidebar. The plugin id is now `agent-sidebar`. If you installed an earlier version by hand, delete the `margin-agent` folder and install again.

## 0.1.1

- Claude gets the vault root along with the open note, so extra folders in your Claude Code settings no longer send it looking in the wrong place.
- Opening the panel picks up the note you last used in the main area.
- While an edit waits for approval, its diff appears only in the permission card.
- Claude Code's internal ToolSearch calls are hidden.
- Paths under your home folder are shown as `~/...`.
- Headings in messages and plans are scaled to the size of body text.

## 0.1.0

First release. A sidebar chat that runs your local Claude Code CLI, with streamed replies, a row per tool call, edit diffs, permission prompts, plan mode, `@` mentions, `/` commands and session history.
