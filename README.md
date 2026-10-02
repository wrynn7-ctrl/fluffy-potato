# Obsidian MCP Server

An [MCP](https://modelcontextprotocol.io) server that lets Claude read, search and edit your Obsidian vault.

It works directly on the vault folder on disk, so it needs no Obsidian plugin and works whether or not
Obsidian is open. Obsidian picks up changes automatically.

## Tools

| Tool | What it does |
|---|---|
| `list_notes` / `list_folder` | Browse notes and folders (hidden folders like `.obsidian` are skipped) |
| `read_note` / `read_notes` | Read one or several notes; accepts a path or a bare note name like a `[[wikilink]]` |
| `search_notes` | Full-text search (plain text or regex) with line numbers |
| `get_note_metadata` | Frontmatter, tags, outgoing links, size and dates |
| `get_backlinks` | Notes linking to a note |
| `list_tags` / `find_notes_by_tag` | Tags from frontmatter and inline `#tags`, including nested tags |
| `get_daily_note` | Reads the daily note, using your Daily Notes folder and date format |
| `create_note` | Create a note (won't overwrite unless asked) |
| `append_to_note` / `prepend_to_note` | Add to the end, or to the top just after the frontmatter |
| `edit_note` | Replace an exact snippet of text |
| `update_frontmatter` | Set or remove properties |
| `move_note` | Rename/move a note and update links to it across the vault |
| `delete_note` | Move to the vault's `.trash` (or delete permanently) |
| `append_to_daily_note` | Append to today's daily note, creating it from your template if needed |

### Safety

- Every path is confined to the vault; `../` escapes are rejected.
- Writes to hidden folders (`.obsidian`, `.trash`, `.git`…) are refused.
- Deletes go to `.trash` by default, as Obsidian does.
- Set `OBSIDIAN_READ_ONLY=true` to expose only the read tools.

## Install

Requires Node.js 18 or newer. On the computer where your vault lives:

```bash
git clone https://github.com/wrynn7-ctrl/fluffy-potato.git obsidian-mcp-server
cd obsidian-mcp-server
npm install
npm run build
```

Find your vault's path: in Obsidian, open the vault switcher (bottom-left) → *Manage vaults*, or right-click
any file → *Reveal in Finder/Explorer* and go up to the vault folder.

## Connect it to Claude

### Claude Desktop

Open *Settings → Developer → Edit Config* and add (use your real paths):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp-server/dist/index.js"],
      "env": { "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/vault" }
    }
  }
}
```

On Windows, use paths like `C:\\Users\\you\\obsidian-mcp-server\\dist\\index.js` (double backslashes).
Restart Claude Desktop; the tools appear under the tools/connectors menu.

### Claude Code

```bash
claude mcp add obsidian --scope user \
  -e OBSIDIAN_VAULT_PATH=/absolute/path/to/your/vault \
  -- node /absolute/path/to/obsidian-mcp-server/dist/index.js
```

Then run `/mcp` inside Claude Code to check it's connected.

## Configuration

| Variable | Meaning |
|---|---|
| `OBSIDIAN_VAULT_PATH` | Vault folder (required; can also be passed as the first argument) |
| `OBSIDIAN_READ_ONLY` | `true` to disable all write tools |

Daily notes follow `.obsidian/daily-notes.json` (folder, date format, template) if the Daily Notes core
plugin is configured; otherwise they're `YYYY-MM-DD.md` in the vault root.

## Development

```bash
npm test   # builds, then runs end-to-end tests against a temporary vault over stdio
```
