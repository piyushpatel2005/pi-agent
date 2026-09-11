// Build a static documentation site from sequenced markdown files.
//
// Pages live under the configured docs directory and use a two-digit prefix —
// `01-what-pi-is.md`, `02-the-run-model.md`, and so on — so order is visible in
// the tree and recoverable without a separate manifest.

import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";

import { markdownToHtml } from "./markdown.ts";

const require = createRequire(import.meta.url);
const MERMAID_DIST = dirname(require.resolve("mermaid/package.json"));

const PAGE_PATTERN = /^(\d{2})-(.+)\.md$/;

export type DocPage = {
  /** Sort key from the filename prefix. */
  order: number;
  /** Filename without directory, e.g. `01-what-pi-is.md`. */
  filename: string;
  /** Path relative to the project root. */
  sourcePath: string;
  /** First `#` heading, or a title derived from the slug. */
  title: string;
  /** URL slug for the built HTML page, e.g. `01-what-pi-is`. */
  slug: string;
};

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function titleFromMarkdown(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1]!.trim();
  }
  return null;
}

function walkMarkdownFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...walkMarkdownFiles(path));
      continue;
    }
    if (entry.endsWith(".md")) files.push(path);
  }

  return files;
}

/** Discover sequenced pages under `docsDir`, ordered by their numeric prefix. */
export function discoverPages(projectDir: string, docsDir = "docs"): DocPage[] {
  const absolute = join(projectDir, docsDir);
  const pages: DocPage[] = [];

  for (const path of walkMarkdownFiles(absolute)) {
    const filename = basename(path);
    const match = filename.match(PAGE_PATTERN);
    if (!match) continue;

    const markdown = readFileSync(path, "utf8");
    const slug = filename.slice(0, -3);
    const order = Number.parseInt(match[1]!, 10);
    const title = titleFromMarkdown(markdown) ?? titleFromSlug(match[2]!);

    pages.push({
      order,
      filename,
      sourcePath: relative(projectDir, path).replace(/\\/g, "/"),
      title,
      slug,
    });
  }

  return pages.sort((left, right) => left.order - right.order);
}

function pageShell(title: string, body: string, nav: string, mermaidScript: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.6 system-ui, sans-serif; margin: 0; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    nav { border-bottom: 1px solid #ccc; padding: 1rem 1.25rem; }
    nav .sections { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
    nav section h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.35rem; color: #666; }
    nav ol { margin: 0; padding-left: 1.1rem; font-size: 0.95rem; }
    nav li { margin: 0.15rem 0; }
    pre { overflow-x: auto; padding: 1rem; border-radius: 0.5rem; background: #f4f4f4; }
    pre.mermaid { background: transparent; padding: 0; }
    .mermaid svg { max-width: 100%; height: auto; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ccc; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
  </style>
</head>
<body>
  <nav>
    <p><strong>pi documentation</strong></p>
    ${nav}
  </nav>
  <main>${body}</main>
  <script type="module">
    import mermaid from "${mermaidScript}";
    mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    await mermaid.run({ querySelector: ".mermaid" });
  </script>
</body>
</html>`;
}

const SECTION_LABELS: Record<string, string> = {
  concepts: "Concepts",
  guides: "Guides",
  reference: "Reference",
  extending: "Extending",
};

function renderNav(pages: DocPage[], hrefPrefix: string): string {
  const groups = new Map<string, DocPage[]>();

  for (const page of pages) {
    const section = page.sourcePath.split("/")[1] ?? "docs";
    const bucket = groups.get(section) ?? [];
    bucket.push(page);
    groups.set(section, bucket);
  }

  const sections = [...groups.entries()]
    .map(([section, sectionPages]) => {
      const items = sectionPages
        .map(
          (page) =>
            `<li><a href="${hrefPrefix}${page.slug}.html">${String(page.order).padStart(2, "0")}. ${page.title}</a></li>`,
        )
        .join("");
      const label = SECTION_LABELS[section] ?? section;
      return `<section><h2>${label}</h2><ol>${items}</ol></section>`;
    })
    .join("");

  return `<div class="sections">${sections}</div>`;
}

function copyMermaidAssets(outDir: string): void {
  const target = join(outDir, "assets", "mermaid");
  mkdirSync(target, { recursive: true });
  cpSync(join(MERMAID_DIST, "dist"), target, { recursive: true });
}

function rewriteLinks(html: string, pages: DocPage[]): string {
  const byBasename = new Map(pages.map((page) => [page.filename, page]));
  return html.replace(/href="([^"]+\.md)"/g, (match, target: string) => {
    const filename = basename(target);
    const page = byBasename.get(filename);
    return page ? `href="${page.slug}.html"` : match;
  });
}

export type BuildResult = {
  pages: DocPage[];
  outDir: string;
};

/** Write `index.html`, one HTML page per sequenced markdown file, and `manifest.json`. */
export function buildStaticSite(
  projectDir: string,
  outDir = "dist/docs",
  docsDir = "docs",
): BuildResult {
  const pages = discoverPages(projectDir, docsDir);
  const absoluteOut = join(projectDir, outDir);
  const pagesDir = join(absoluteOut, "pages");
  mkdirSync(pagesDir, { recursive: true });
  copyMermaidAssets(absoluteOut);

  const mermaidRoot = "./assets/mermaid/mermaid.esm.min.mjs";
  const mermaidPage = "../assets/mermaid/mermaid.esm.min.mjs";

  const navForIndex = renderNav(pages, "pages/");
  const navForPage = renderNav(pages, "");

  for (const page of pages) {
    const markdown = readFileSync(join(projectDir, page.sourcePath), "utf8");
    const body = rewriteLinks(markdownToHtml(markdown), pages);
    const html = pageShell(page.title, body, navForPage, mermaidPage);
    writeFileSync(join(pagesDir, `${page.slug}.html`), html, "utf8");
  }

  const first = pages[0];
  const indexBody = [
    "<h1>pi documentation</h1>",
    "<p>A workflow harness for coding agents: personas, guarded tools, checkpoints, and traceability.</p>",
    first
      ? `<p>New here? Start with <a href="pages/${first.slug}.html">${first.title}</a>, ` +
        `or pick a section from the table of contents above.</p>`
      : "<p>No pages were built.</p>",
  ].join("\n");

  writeFileSync(
    join(absoluteOut, "index.html"),
    pageShell("pi documentation", indexBody, navForIndex, mermaidRoot),
    "utf8",
  );
  writeFileSync(
    join(absoluteOut, "manifest.json"),
    JSON.stringify(
      pages.map((page) => ({
        order: page.order,
        title: page.title,
        source: page.sourcePath,
        html: `pages/${page.slug}.html`,
      })),
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return { pages, outDir };
}

/** True when every markdown file under `docsDir` uses the sequenced naming scheme. */
export function sequencedDocsComplete(projectDir: string, docsDir = "docs"): boolean {
  const absolute = join(projectDir, docsDir);
  const markdown = walkMarkdownFiles(absolute);
  return markdown.length > 0 && markdown.every((path) => PAGE_PATTERN.test(basename(path)));
}
