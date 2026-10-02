import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface SearchMatch {
  path: string;
  matches: { line: number; text: string }[];
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_RE = /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK_RE = /\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;
const INLINE_TAG_RE = /(?:^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export class VaultError extends Error {}

/**
 * File-system access to an Obsidian vault. Every path accepted from callers is
 * relative to the vault root and is checked so it can never escape it.
 */
export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a vault-relative path to an absolute one, refusing anything outside the vault. */
  resolve(relPath: string): string {
    const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = path.resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new VaultError(`Path escapes the vault: ${relPath}`);
    }
    return abs;
  }

  /** Normalise a note path: forward slashes, no leading slash, `.md` appended if no extension. */
  notePath(relPath: string): string {
    let p = relPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!p) throw new VaultError("Note path must not be empty");
    if (!path.posix.extname(p)) p += ".md";
    this.resolve(p);
    return p;
  }

  private assertWritable(relPath: string): void {
    const parts = relPath.split("/");
    if (parts.some((part) => part.startsWith("."))) {
      throw new VaultError(`Refusing to write to hidden path: ${relPath}`);
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  /** List markdown notes under a folder (vault-relative), skipping hidden folders like `.obsidian`. */
  async listNotes(folder = "", recursive = true): Promise<string[]> {
    const start = this.resolve(folder);
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new VaultError(`Folder not found: ${folder}`);
        }
        throw err;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) await walk(abs);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          results.push(this.toRel(abs));
        }
      }
    };
    await walk(start);
    return results.sort();
  }

  /** List immediate subfolders and notes of a folder. */
  async listFolder(folder = ""): Promise<{ folders: string[]; files: string[] }> {
    const dir = this.resolve(folder);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
      if (err.code === "ENOENT") throw new VaultError(`Folder not found: ${folder}`);
      throw err;
    });
    const folders: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = this.toRel(path.join(dir, entry.name));
      if (entry.isDirectory()) folders.push(rel + "/");
      else if (entry.isFile()) files.push(rel);
    }
    return { folders: folders.sort(), files: files.sort() };
  }

  async read(relPath: string): Promise<string> {
    const p = this.notePath(relPath);
    try {
      return await fs.readFile(this.resolve(p), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const resolved = await this.resolveLink(relPath.replace(/\.md$/, ""));
        if (resolved && resolved !== p) return this.read(resolved);
        throw new VaultError(`Note not found: ${p}`);
      }
      throw err;
    }
  }

  async write(relPath: string, content: string, opts: { overwrite: boolean }): Promise<string> {
    const p = this.notePath(relPath);
    this.assertWritable(p);
    const abs = this.resolve(p);
    if (!opts.overwrite && (await this.exists(p))) {
      throw new VaultError(`Note already exists: ${p}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return p;
  }

  async append(relPath: string, content: string): Promise<string> {
    const p = this.notePath(relPath);
    const existing = (await this.exists(p)) ? await fs.readFile(this.resolve(p), "utf8") : "";
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    return this.write(p, existing + sep + content, { overwrite: true });
  }

  /** Insert content after the frontmatter block (if any). */
  async prepend(relPath: string, content: string): Promise<string> {
    const p = this.notePath(relPath);
    const existing = (await this.exists(p)) ? await fs.readFile(this.resolve(p), "utf8") : "";
    const fm = existing.match(FRONTMATTER_RE);
    const head = fm ? fm[0] : "";
    const rest = existing.slice(head.length);
    const sep = content.endsWith("\n") || !rest ? "" : "\n";
    return this.write(p, head + content + sep + rest, { overwrite: true });
  }

  /** Replace an exact snippet of text. Fails unless the snippet occurs exactly once (or replaceAll is set). */
  async replaceText(relPath: string, oldText: string, newText: string, replaceAll = false): Promise<number> {
    const p = this.notePath(relPath);
    const content = await this.read(p);
    const count = oldText ? content.split(oldText).length - 1 : 0;
    if (count === 0) throw new VaultError(`Text not found in ${p}`);
    if (count > 1 && !replaceAll) {
      throw new VaultError(`Text occurs ${count} times in ${p}; add more context or set replace_all`);
    }
    await this.write(p, content.split(oldText).join(newText), { overwrite: true });
    return count;
  }

  /** Move a note to the vault's `.trash` folder (Obsidian's "move to Obsidian trash"), or delete it permanently. */
  async delete(relPath: string, permanent: boolean): Promise<string> {
    const p = this.notePath(relPath);
    this.assertWritable(p);
    const abs = this.resolve(p);
    if (!(await this.exists(p))) throw new VaultError(`Note not found: ${p}`);
    if (permanent) {
      await fs.unlink(abs);
      return "deleted permanently";
    }
    const trashDir = path.join(this.root, ".trash");
    await fs.mkdir(trashDir, { recursive: true });
    let dest = path.join(trashDir, path.basename(abs));
    if (await fs.access(dest).then(() => true, () => false)) {
      const ext = path.extname(abs);
      dest = path.join(trashDir, `${path.basename(abs, ext)} ${Date.now()}${ext}`);
    }
    await fs.rename(abs, dest);
    return `moved to ${this.toRel(dest)}`;
  }

  /**
   * Rename/move a note. When updateLinks is set, wikilinks and markdown links pointing at the
   * old note are rewritten across the vault, the way Obsidian does on rename.
   */
  async move(from: string, to: string, updateLinks: boolean): Promise<{ path: string; updatedNotes: string[] }> {
    const src = this.notePath(from);
    const dest = this.notePath(to);
    this.assertWritable(src);
    this.assertWritable(dest);
    if (!(await this.exists(src))) throw new VaultError(`Note not found: ${src}`);
    if (await this.exists(dest)) throw new VaultError(`Destination already exists: ${dest}`);
    await fs.mkdir(path.dirname(this.resolve(dest)), { recursive: true });
    await fs.rename(this.resolve(src), this.resolve(dest));

    const updatedNotes: string[] = [];
    if (updateLinks) {
      const oldNoExt = src.replace(/\.md$/, "");
      const oldBase = path.posix.basename(oldNoExt);
      const newNoExt = dest.replace(/\.md$/, "");
      const newBase = path.posix.basename(newNoExt);
      // Use the bare name if it is still unambiguous in the vault, otherwise the full path.
      const all = await this.listNotes();
      const newTarget =
        all.filter((n) => path.posix.basename(n, ".md").toLowerCase() === newBase.toLowerCase()).length > 1
          ? newNoExt
          : newBase;
      const oldBaseAmbiguous = all.some(
        (n) => n !== dest && path.posix.basename(n, ".md").toLowerCase() === oldBase.toLowerCase(),
      );

      for (const note of all) {
        const abs = this.resolve(note);
        const content = await fs.readFile(abs, "utf8");
        let changed = content.replace(
          /(!?\[\[)([^\]|#^]+)((?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\])/g,
          (match, open: string, target: string, rest: string) => {
            const t = target.trim().replace(/\.md$/, "").toLowerCase();
            if (t === oldNoExt.toLowerCase() || (!oldBaseAmbiguous && t === oldBase.toLowerCase())) {
              return open + newTarget + rest;
            }
            return match;
          },
        );
        changed = changed.replace(
          /(\[[^\]]*\]\()([^)\s]+\.md)((?:#[^)]*)?\))/g,
          (match, open: string, target: string, rest: string) => {
            const fromDir = path.posix.dirname(note === dest ? src : note);
            const resolved = path.posix.normalize(path.posix.join(fromDir, decodeURI(target)));
            if (resolved !== src) return match;
            const rel = path.posix.relative(path.posix.dirname(note), dest);
            return open + encodeURI(rel) + rest;
          },
        );
        if (changed !== content) {
          await fs.writeFile(abs, changed, "utf8");
          updatedNotes.push(note);
        }
      }
    }
    return { path: dest, updatedNotes };
  }

  /** Full-text search across notes. Plain substring by default, or a regular expression. */
  async search(
    query: string,
    opts: { regex?: boolean; caseSensitive?: boolean; folder?: string; limit?: number } = {},
  ): Promise<SearchMatch[]> {
    const flags = opts.caseSensitive ? "" : "i";
    const pattern = opts.regex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const limit = opts.limit ?? 50;
    const results: SearchMatch[] = [];
    for (const note of await this.listNotes(opts.folder ?? "")) {
      const content = await fs.readFile(this.resolve(note), "utf8");
      const matches: SearchMatch["matches"] = [];
      const nameHit = pattern.test(note);
      content.split(/\r?\n/).forEach((text, i) => {
        if (pattern.test(text)) matches.push({ line: i + 1, text: text.length > 300 ? text.slice(0, 300) + "…" : text });
      });
      if (matches.length || nameHit) {
        results.push({ path: note, matches: matches.slice(0, 10) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  parse(content: string): ParsedNote {
    const m = content.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: {}, body: content };
    let frontmatter: Record<string, unknown> = {};
    try {
      const parsed = YAML.parse(m[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed;
    } catch {
      // Malformed YAML: treat as no frontmatter rather than failing the whole read.
    }
    return { frontmatter, body: content.slice(m[0].length) };
  }

  /** Merge keys into a note's frontmatter. A value of null removes the key. */
  async updateFrontmatter(relPath: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.notePath(relPath);
    const content = await this.read(p);
    const { frontmatter, body } = this.parse(content);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete frontmatter[key];
      else frontmatter[key] = value;
    }
    const yaml = Object.keys(frontmatter).length ? `---\n${YAML.stringify(frontmatter)}---\n` : "";
    await this.write(p, yaml + body, { overwrite: true });
    return frontmatter;
  }

  /** Tags from both frontmatter (`tags:`) and inline `#tags`, without the leading `#`. */
  extractTags(content: string): string[] {
    const { frontmatter, body } = this.parse(content);
    const tags = new Set<string>();
    const fmTags = frontmatter.tags ?? frontmatter.tag;
    const fmList = Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? fmTags.split(/[,\s]+/) : [];
    for (const t of fmList) if (t) tags.add(String(t).replace(/^#/, ""));
    const stripped = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(INLINE_TAG_RE)) tags.add(m[1]);
    return [...tags];
  }

  async allTags(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const note of await this.listNotes()) {
      for (const tag of this.extractTags(await fs.readFile(this.resolve(note), "utf8"))) {
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  }

  /** Notes carrying a tag. Nested tags match too: `project` matches `project/alpha`. */
  async notesWithTag(tag: string): Promise<string[]> {
    const wanted = tag.replace(/^#/, "").toLowerCase();
    const out: string[] = [];
    for (const note of await this.listNotes()) {
      const tags = this.extractTags(await fs.readFile(this.resolve(note), "utf8")).map((t) => t.toLowerCase());
      if (tags.some((t) => t === wanted || t.startsWith(wanted + "/"))) out.push(note);
    }
    return out;
  }

  /** Outgoing links (wikilink targets and relative markdown links) of a note. */
  extractLinks(content: string): string[] {
    const links = new Set<string>();
    for (const m of content.matchAll(WIKILINK_RE)) links.add(m[1].trim());
    for (const m of content.matchAll(MDLINK_RE)) links.add(decodeURI(m[1]));
    return [...links];
  }

  /** Resolve a link target the way Obsidian does: exact path first, then by note name. */
  async resolveLink(target: string, fromNote?: string, notes?: string[]): Promise<string | null> {
    const t = target.replace(/\.md$/, "").replace(/^\/+/, "");
    const all = notes ?? (await this.listNotes());
    const lower = t.toLowerCase();
    if (fromNote) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromNote), t)) + ".md";
      if (all.includes(rel)) return rel;
    }
    const exact = all.find((n) => n.slice(0, -3).toLowerCase() === lower);
    if (exact) return exact;
    const byName = all.filter((n) => n.slice(0, -3).toLowerCase().endsWith("/" + lower));
    byName.sort((a, b) => a.length - b.length);
    return byName[0] ?? null;
  }

  /** Notes that link to the given note, with the lines containing the links. */
  async backlinks(relPath: string): Promise<SearchMatch[]> {
    const target = this.notePath(relPath);
    const results: SearchMatch[] = [];
    const all = await this.listNotes();
    for (const note of all) {
      if (note === target) continue;
      const content = await fs.readFile(this.resolve(note), "utf8");
      const lines = content.split(/\r?\n/);
      const matches: SearchMatch["matches"] = [];
      for (let i = 0; i < lines.length; i++) {
        for (const link of this.extractLinks(lines[i])) {
          if ((await this.resolveLink(link, note, all)) === target) {
            matches.push({ line: i + 1, text: lines[i] });
            break;
          }
        }
      }
      if (matches.length) results.push({ path: note, matches });
    }
    return results;
  }

  /** Path of the daily note for a date, honouring `.obsidian/daily-notes.json` when present. */
  async dailyNotePath(date: Date): Promise<{ path: string; template?: string }> {
    let config: { folder?: string; format?: string; template?: string } = {};
    try {
      config = JSON.parse(await fs.readFile(path.join(this.root, ".obsidian", "daily-notes.json"), "utf8"));
    } catch {
      // No daily-notes config: use Obsidian's defaults.
    }
    const name = formatDate(date, config.format || "YYYY-MM-DD");
    const folder = (config.folder ?? "").replace(/^\/+|\/+$/g, "");
    return { path: this.notePath(folder ? `${folder}/${name}` : name), template: config.template || undefined };
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Format a date using the subset of moment.js tokens commonly used in Obsidian daily-note formats. */
export function formatDate(d: Date, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => MONTHS[d.getMonth()],
    MMM: () => MONTHS[d.getMonth()].slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => DAYS[d.getDay()],
    ddd: () => DAYS[d.getDay()].slice(0, 3),
  };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g, (m, literal) =>
    literal !== undefined ? literal : tokens[m](),
  );
}
