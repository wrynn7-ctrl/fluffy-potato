import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let vault;
let client;

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content[0].text, isError: res.isError };
};

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "vault-"));
  await mkdir(path.join(vault, "Projects"));
  await mkdir(path.join(vault, ".obsidian"));
  await writeFile(path.join(vault, ".obsidian", "daily-notes.json"), JSON.stringify({ folder: "Daily", format: "YYYY-MM-DD" }));
  await writeFile(path.join(vault, "Home.md"), "# Home\nSee [[Alpha]] and [[Projects/Alpha|the alpha]].\n#index\n");
  await writeFile(
    path.join(vault, "Projects", "Alpha.md"),
    "---\nstatus: active\ntags: [project/alpha]\n---\nAlpha body with a secret word: pineapple.\n",
  );
  await writeFile(path.join(vault, "Other.md"), "Link [alpha](Projects/Alpha.md) here.\n");

  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, OBSIDIAN_VAULT_PATH: vault }, stderr: "ignore" }),
  );
});

after(async () => {
  await client?.close();
  await rm(vault, { recursive: true, force: true });
});

test("lists tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["read_note", "search_notes", "create_note", "edit_note", "move_note", "get_backlinks"]) {
    assert.ok(names.includes(n), n);
  }
});

test("list and read", async () => {
  assert.equal((await call("list_notes")).text, "Home.md\nOther.md\nProjects/Alpha.md");
  assert.match((await call("read_note", { path: "Alpha" })).text, /pineapple/);
});

test("search, tags, metadata, backlinks", async () => {
  assert.match((await call("search_notes", { query: "PINEAPPLE" })).text, /Projects\/Alpha.md\n  5:/);
  assert.match((await call("find_notes_by_tag", { tag: "#project" })).text, /Projects\/Alpha.md/);
  const tags = JSON.parse((await call("list_tags")).text);
  assert.deepEqual(tags, { "project/alpha": 1, index: 1 });
  const meta = JSON.parse((await call("get_note_metadata", { path: "Projects/Alpha" })).text);
  assert.equal(meta.frontmatter.status, "active");
  const back = (await call("get_backlinks", { path: "Projects/Alpha" })).text;
  assert.match(back, /Home.md/);
  assert.match(back, /Other.md/);
});

test("rejects paths outside the vault and hidden folders", async () => {
  assert.equal((await call("read_note", { path: "../../etc/passwd" })).isError, true);
  assert.equal((await call("create_note", { path: ".obsidian/x", content: "x" })).isError, true);
});

test("create, append, prepend, edit, frontmatter", async () => {
  assert.equal((await call("create_note", { path: "New/Note", content: "line1\n" })).text, "Wrote New/Note.md");
  assert.equal((await call("create_note", { path: "New/Note", content: "x" })).isError, true);
  await call("append_to_note", { path: "New/Note", content: "line2\n" });
  await call("update_frontmatter", { path: "New/Note", properties: { status: "draft" } });
  await call("prepend_to_note", { path: "New/Note", content: "top\n" });
  await call("edit_note", { path: "New/Note", old_text: "line2", new_text: "LINE2" });
  assert.equal(await readFile(path.join(vault, "New", "Note.md"), "utf8"), "---\nstatus: draft\n---\ntop\nline1\nLINE2\n");
  await call("update_frontmatter", { path: "New/Note", properties: { status: null } });
  assert.equal(await readFile(path.join(vault, "New", "Note.md"), "utf8"), "top\nline1\nLINE2\n");
});

test("move updates links", async () => {
  const res = await call("move_note", { from: "Projects/Alpha", to: "Archive/Beta" });
  assert.match(res.text, /Home.md/);
  assert.equal(await readFile(path.join(vault, "Home.md"), "utf8"), "# Home\nSee [[Beta]] and [[Beta|the alpha]].\n#index\n");
  assert.equal(await readFile(path.join(vault, "Other.md"), "utf8"), "Link [alpha](Archive/Beta.md) here.\n");
});

test("daily note and delete to trash", async () => {
  await call("append_to_daily_note", { content: "- did a thing", date: "2026-01-05" });
  assert.match((await call("get_daily_note", { date: "2026-01-05" })).text, /Daily\/2026-01-05.md[\s\S]*did a thing/);
  assert.match((await call("delete_note", { path: "Other" })).text, /\.trash\/Other.md/);
  await access(path.join(vault, ".trash", "Other.md"));
});
