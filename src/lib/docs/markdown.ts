import { type DocOptions, DEFAULT_BODY } from "./util";

/**
 * Markdown file with `![]()` image syntax pointing at the trigger URL.
 *
 * Note apps that render Markdown inline (Joplin, Trilium, Logseq, Obsidian,
 * Gitea README viewer, Discourse posts) will fetch the image on display.
 *
 * Plain-text viewers won't fire, but the trailing link line preserves the URL
 * for anyone scanning the raw file.
 */
export function generateMarkdown(opts: DocOptions): Promise<Buffer> {
  const title = opts.title.replace(/[\r\n]+/g, " ");
  const body = (opts.body ?? DEFAULT_BODY).join("\n\n");

  const md = `# ${title}

![${title}](${opts.url})

${body}

---

[${title}](${opts.url})
`;
  return Promise.resolve(Buffer.from(md, "utf8"));
}
