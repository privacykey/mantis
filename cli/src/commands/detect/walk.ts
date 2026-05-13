import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

/**
 * Filesystem walker used by --deep. Recursive, text-extension-filtered,
 * with sane skip-list for noisy/uninteresting directories. Designed to
 * complete in <60s on a typical home directory.
 *
 * Hard caps so a pathological filesystem doesn't pin the CPU:
 *   - MAX_FILES: total files actually opened for content
 *   - MAX_FILE_SIZE: per-file byte cap (large files are truncated, not skipped)
 *   - MAX_DEPTH: directory recursion depth
 */
const MAX_FILES = 50_000;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MiB
const MAX_DEPTH = 16;

const SKIP_DIR_NAMES = new Set<string>([
  // VCS / build caches
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".m2",
  ".cargo",
  ".rustup",
  ".pyenv",
  ".rbenv",
  ".nvm",
  ".asdf",
  "venv",
  ".venv",
  "__pycache__",
  // OS / app caches
  "Library", // macOS — we cover the few specific subpaths in scope=system already
  "Caches",
  "Logs",
  ".docker",
  ".vagrant",
  ".Trash",
  "Trash",
  // Media (binary, irrelevant)
  "Pictures",
  "Photos",
  "Music",
  "Movies",
  "Videos",
]);

const TEXT_EXTS = new Set<string>([
  ".txt", ".md", ".rst", ".org",
  ".sh", ".bash", ".zsh", ".fish",
  ".py", ".rb", ".pl", ".php", ".lua", ".tcl",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".xml", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".sql", ".pgsql",
  ".applescript", ".scpt",
  ".plist",
  ".service", ".socket", ".timer", ".path",
  ".tf", ".tfvars",
  ".dockerfile",
  ".gitconfig", ".gitignore", ".gitattributes",
  ".csv", ".tsv",
  // Notes apps
  ".otl", ".taskpaper",
]);

// Common dotfile names (no extension) we want to treat as text.
const TEXT_DOTFILES = new Set<string>([
  ".bashrc", ".zshrc", ".bash_profile", ".profile", ".zprofile", ".inputrc",
  ".gitconfig", ".gitignore", ".gitignore_global",
  ".vimrc", ".tmux.conf", ".tigrc",
  ".npmrc", ".yarnrc", ".pip.conf",
  ".env", ".env.local", ".env.development", ".env.production",
  ".envrc",
  "Brewfile", "Dockerfile", "Makefile", "Procfile", "Rakefile",
]);

export type WalkOptions = {
  /** Roots to scan. */
  roots: string[];
  /** Per-file invoker. Skip subsequent files by throwing AbortError. */
  onFile: (file: { path: string; content: string }) => Promise<void> | void;
  /** Per-skipped-by-permissions invoker. Best-effort surfacing in the summary. */
  onPermissionDenied?: (path: string) => void;
  /** Stop after this many files. Defaults to MAX_FILES. */
  fileLimit?: number;
  /** Stop after this many bytes scanned. Defaults to none (per-file cap still applies). */
  byteLimit?: number;
  /** Progress callback fired every 1000 files. */
  onProgress?: (stats: { scanned: number; bytes: number }) => void;
};

export type WalkResult = {
  scanned: number;
  bytes: number;
  truncated: boolean;
  reachedLimit: boolean;
};

/**
 * Walks the given roots, calling `onFile` for each text-like file under
 * MAX_FILE_SIZE (truncated if larger). Returns count + byte stats.
 *
 * Pure breadth-first DFS — no concurrency. Most homes complete in tens of
 * seconds; concurrency would only matter for network-mounted dirs and adds
 * complexity (open-file-descriptor limits, ordering).
 */
export async function walkText(opts: WalkOptions): Promise<WalkResult> {
  const fileLimit = opts.fileLimit ?? MAX_FILES;
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  let reachedLimit = false;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (reachedLimit) return;
    if (depth > MAX_DEPTH) return;

    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>;
    try {
      const raw = await readdir(dir, { withFileTypes: true });
      entries = raw.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        opts.onPermissionDenied?.(dir);
      }
      return;
    }

    // Process files first, then recurse — keeps memory low.
    for (const entry of entries) {
      if (reachedLimit) return;

      // Skip symlinks entirely — avoids cycles and "I scanned /tmp/x → /etc"
      // surprises. Reduces signal slightly; safer default.
      if (entry.isSymbolicLink) continue;

      const path = join(dir, entry.name);

      if (entry.isFile && isTextFile(entry.name)) {
        let st;
        try {
          st = await stat(path);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const readSize = Math.min(st.size, MAX_FILE_SIZE);
        if (readSize === 0) continue;

        let content: string;
        try {
          const buf = await readFile(path);
          content =
            buf.length > MAX_FILE_SIZE
              ? buf.subarray(0, MAX_FILE_SIZE).toString("utf8")
              : buf.toString("utf8");
          if (buf.length > MAX_FILE_SIZE) truncated = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EACCES" || code === "EPERM") opts.onPermissionDenied?.(path);
          continue;
        }
        bytes += content.length;
        scanned++;
        if (scanned % 1000 === 0) opts.onProgress?.({ scanned, bytes });

        try {
          await opts.onFile({ path, content });
        } catch {
          // Detector errors are non-fatal; keep walking.
        }

        if (scanned >= fileLimit) {
          reachedLimit = true;
          return;
        }
        if (opts.byteLimit !== undefined && bytes >= opts.byteLimit) {
          reachedLimit = true;
          return;
        }
      }
    }

    for (const entry of entries) {
      if (reachedLimit) return;
      if (entry.isSymbolicLink) continue;
      if (!entry.isDirectory) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // Skip hidden dot-directories EXCEPT a small allowlist we DO want to look at.
      if (
        entry.name.startsWith(".") &&
        entry.name !== ".config" &&
        entry.name !== ".local" &&
        entry.name !== ".ssh" &&
        !DOTDIR_ALLOWLIST.has(entry.name)
      ) {
        continue;
      }
      await visit(join(dir, entry.name), depth + 1);
    }
  };

  for (const root of opts.roots) {
    await visit(root, 0);
    if (reachedLimit) break;
  }
  return { scanned, bytes, truncated, reachedLimit };
}

const DOTDIR_ALLOWLIST = new Set<string>([
  ".config",
  ".local",
  ".ssh",
  ".obsidian",
  ".notes",
]);

function isTextFile(name: string): boolean {
  if (TEXT_DOTFILES.has(name)) return true;
  const ext = extname(name).toLowerCase();
  if (!ext) return false;
  return TEXT_EXTS.has(ext);
}
