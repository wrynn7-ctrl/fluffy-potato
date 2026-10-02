#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vault, VaultError } from "./vault.js";

const vaultPath = process.env.OBSIDIAN_VAULT_PATH ?? process.argv[2];
if (!vaultPath) {
  console.error("Usage: obsidian-mcp-server <vault-path>  (or set OBSIDIAN_VAULT_PATH)");
  process.exit(1);
}
const stat = await fs.stat(vaultPath).catch(() => null);
if (!stat?.isDirectory()) {
  console.error(`Vault folder not found: ${vaultPath}`);
  process.exit(1);
}

const readOnly = /^(1|true|yes)$/i.test(process.env.OBSIDIAN_READ_ONLY ?? "");
const vault = new Vault(vaultPath);
const server = new McpServer({ name: "obsidian", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** Run a handler, turning vault errors into tool errors Claude can read and recover from. */
function handle<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return text(await fn(args));
    } catch (err) {
      if (err instanceof VaultError || err instanceof SyntaxError) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
      throw err;
    }
  };
}

const notePath = z.string().describe('Vault-relative note path, e.g. "Projects/Plan.md" (".md" optional)');

// ---------- Reading ----------

server.registerTool(
  "list_notes",
  {
    title: "List notes",
    description: "List markdown notes in the vault or in a folder. Hidden folders such as .obsidian and .trash are skipped.",
    inputSchema: {
      folder: z.string().optional().describe("Vault-relative folder; defaults to the vault root"),
      recursive: z.boolean().optional().describe("Include subfolders (default true)"),
    },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ folder, recursive }) => {
    const notes = await vault.listNotes(folder ?? "", recursive ?? true);
    return notes.length ? notes.join("\n") : "No notes found.";
  }),
);

server.registerTool(
  "list_folder",
  {
    title: "List folder",
    description: "Show the immediate subfolders and files of a folder, like a file browser.",
    inputSchema: { folder: z.string().optional().describe("Vault-relative folder; defaults to the vault root") },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ folder }) => vault.listFolder(folder ?? "")),
);

server.registerTool(
  "read_note",
  {
    title: "Read note",
    description:
      "Read a note's full markdown. Accepts a path or just a note name (resolved like an Obsidian [[wikilink]]).",
    inputSchema: { path: notePath },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ path }) => vault.read(path)),
);

server.registerTool(
  "read_notes",
  {
    title: "Read several notes",
    description: "Read multiple notes in one call. Missing notes are reported instead of failing the call.",
    inputSchema: { paths: z.array(notePath).min(1).max(20) },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ paths }) => {
    const parts = await Promise.all(
      paths.map(async (p) => {
        try {
          return `=== ${vault.notePath(p)} ===\n${await vault.read(p)}`;
        } catch (err) {
          return `=== ${p} ===\nError: ${(err as Error).message}`;
        }
      }),
    );
    return parts.join("\n\n");
  }),
);

server.registerTool(
  "search_notes",
  {
    title: "Search notes",
    description:
      "Full-text search across note contents and file names. Returns matching notes with line numbers and the matching lines.",
    inputSchema: {
      query: z.string().min(1).describe("Text to find, or a regular expression when regex is true"),
      regex: z.boolean().optional(),
      case_sensitive: z.boolean().optional(),
      folder: z.string().optional().describe("Restrict the search to this folder"),
      limit: z.number().int().positive().max(500).optional().describe("Maximum notes to return (default 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ query, regex, case_sensitive, folder, limit }) => {
    const results = await vault.search(query, { regex, caseSensitive: case_sensitive, folder, limit });
    if (!results.length) return "No matches.";
    return results
      .map((r) => [r.path, ...r.matches.map((m) => `  ${m.line}: ${m.text}`)].join("\n"))
      .join("\n\n");
  }),
);

server.registerTool(
  "get_note_metadata",
  {
    title: "Get note metadata",
    description: "Get a note's frontmatter properties, tags, outgoing links, and file size/modified time.",
    inputSchema: { path: notePath },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ path }) => {
    const p = vault.notePath(path);
    const content = await vault.read(p);
    const st = await fs.stat(vault.resolve(p)).catch(() => null);
    return {
      path: p,
      frontmatter: vault.parse(content).frontmatter,
      tags: vault.extractTags(content),
      links: vault.extractLinks(content),
      size: st?.size,
      modified: st?.mtime.toISOString(),
      created: st?.birthtime.toISOString(),
    };
  }),
);

server.registerTool(
  "get_backlinks",
  {
    title: "Get backlinks",
    description: "Find every note that links to the given note, with the linking lines.",
    inputSchema: { path: notePath },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ path }) => {
    const results = await vault.backlinks(path);
    if (!results.length) return "No backlinks.";
    return results
      .map((r) => [r.path, ...r.matches.map((m) => `  ${m.line}: ${m.text}`)].join("\n"))
      .join("\n\n");
  }),
);

server.registerTool(
  "list_tags",
  {
    title: "List tags",
    description: "List every tag in the vault (frontmatter and inline #tags) with how many notes use it.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  handle(async () => vault.allTags()),
);

server.registerTool(
  "find_notes_by_tag",
  {
    title: "Find notes by tag",
    description: 'List notes carrying a tag. Nested tags are included, so "project" also matches "project/alpha".',
    inputSchema: { tag: z.string().min(1).describe('Tag with or without "#"') },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ tag }) => {
    const notes = await vault.notesWithTag(tag);
    return notes.length ? notes.join("\n") : `No notes tagged #${tag.replace(/^#/, "")}.`;
  }),
);

server.registerTool(
  "get_daily_note",
  {
    title: "Get daily note",
    description:
      "Read the daily note for a date (default today), using the folder and date format from Obsidian's Daily Notes settings.",
    inputSchema: { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ date }) => {
    const { path } = await vault.dailyNotePath(parseDate(date));
    if (!(await vault.exists(path))) return `Daily note ${path} does not exist yet.`;
    return `=== ${path} ===\n${await vault.read(path)}`;
  }),
);

// ---------- Writing ----------

if (!readOnly) {
  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Create a new note. Folders are created as needed. Fails if the note exists unless overwrite is true.",
      inputSchema: {
        path: notePath,
        content: z.string(),
        overwrite: z.boolean().optional().describe("Replace an existing note (default false)"),
      },
    },
    handle(async ({ path, content, overwrite }) => {
      const p = await vault.write(path, content, { overwrite: overwrite ?? false });
      return `Wrote ${p}`;
    }),
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append to note",
      description: "Add content to the end of a note, creating the note if it doesn't exist.",
      inputSchema: { path: notePath, content: z.string() },
    },
    handle(async ({ path, content }) => `Appended to ${await vault.append(path, content)}`),
  );

  server.registerTool(
    "prepend_to_note",
    {
      title: "Prepend to note",
      description: "Add content to the start of a note, just after its frontmatter. Creates the note if needed.",
      inputSchema: { path: notePath, content: z.string() },
    },
    handle(async ({ path, content }) => `Prepended to ${await vault.prepend(path, content)}`),
  );

  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Replace an exact snippet of text in a note. old_text must match exactly once unless replace_all is true. Read the note first.",
      inputSchema: {
        path: notePath,
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().optional(),
      },
    },
    handle(async ({ path, old_text, new_text, replace_all }) => {
      const n = await vault.replaceText(path, old_text, new_text, replace_all ?? false);
      return `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${vault.notePath(path)}`;
    }),
  );

  server.registerTool(
    "update_frontmatter",
    {
      title: "Update frontmatter",
      description: "Set or remove frontmatter properties. Keys are merged into existing ones; a null value removes a key.",
      inputSchema: {
        path: notePath,
        properties: z.record(z.string(), z.any()).describe('e.g. {"status": "done", "tags": ["a","b"], "draft": null}'),
      },
    },
    handle(async ({ path, properties }) => vault.updateFrontmatter(path, properties)),
  );

  server.registerTool(
    "move_note",
    {
      title: "Move or rename note",
      description: "Move or rename a note. By default, links to it elsewhere in the vault are updated, as Obsidian does.",
      inputSchema: {
        from: notePath,
        to: notePath,
        update_links: z.boolean().optional().describe("Rewrite links pointing at the note (default true)"),
      },
      annotations: { destructiveHint: true },
    },
    handle(async ({ from, to, update_links }) => {
      const { path, updatedNotes } = await vault.move(from, to, update_links ?? true);
      return updatedNotes.length
        ? `Moved to ${path}. Updated links in:\n${updatedNotes.join("\n")}`
        : `Moved to ${path}.`;
    }),
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Delete a note. By default it goes to the vault's .trash folder so it can be recovered.",
      inputSchema: {
        path: notePath,
        permanent: z.boolean().optional().describe("Delete permanently instead of moving to .trash (default false)"),
      },
      annotations: { destructiveHint: true },
    },
    handle(async ({ path, permanent }) => `${vault.notePath(path)}: ${await vault.delete(path, permanent ?? false)}`),
  );

  server.registerTool(
    "append_to_daily_note",
    {
      title: "Append to daily note",
      description:
        "Append content to the daily note for a date (default today). Creates it from the Daily Notes template if it doesn't exist.",
      inputSchema: {
        content: z.string(),
        date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      },
    },
    handle(async ({ content, date }) => {
      const { path, template } = await vault.dailyNotePath(parseDate(date));
      if (!(await vault.exists(path)) && template) {
        const body = await vault.read(template).catch(() => "");
        await vault.write(path, body, { overwrite: false });
      }
      return `Appended to ${await vault.append(path, content)}`;
    }),
  );
}

function parseDate(date?: string): Date {
  if (!date) return new Date();
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new VaultError(`Invalid date "${date}", expected YYYY-MM-DD`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

await server.connect(new StdioServerTransport());
console.error(`Obsidian MCP server running on vault ${vault.root}${readOnly ? " (read-only)" : ""}`);
