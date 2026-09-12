// Build a static documentation site from sequenced markdown files.
//
// Pages live under the configured docs directory and use a two-digit prefix —
// `01-what-pi-is.md`, `02-the-run-model.md`, and so on — so order is visible in
// the tree and recoverable without a separate manifest.
//
// The repository README is the first page in the reading sequence, followed by
// every sequenced page in numeric order.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { markdownToHtml } from "./markdown.ts";

const require = createRequire(import.meta.url);
const MERMAID_DIST = dirname(require.resolve("mermaid/package.json"));
const THEME_CSS = join(dirname(fileURLToPath(import.meta.url)), "theme.css");

const PAGE_PATTERN = /^(\d{2})-(.+)\.md$/;
const README_SLUG = "readme";

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

const SECTION_LABELS: Record<string, string> = {
  concepts: "Concepts",
  guides: "Guides",
  reference: "Reference",
  extending: "Extending",
};

type PageLocation = "index" | "readme" | "page";

function renderNav(
  pages: DocPage[],
  hrefPrefix: string,
  current: { location: PageLocation; slug?: string },
): string {
  const groups = new Map<string, DocPage[]>();

  for (const page of pages) {
    const section = page.sourcePath.split("/")[1] ?? "docs";
    const bucket = groups.get(section) ?? [];
    bucket.push(page);
    groups.set(section, bucket);
  }

  const readmeCurrent = current.location === "readme";
  const readmeItem = `<li><a href="${hrefPrefix}${README_SLUG}.html"${
    readmeCurrent ? ' aria-current="page"' : ""
  }>README</a></li>`;

  const sections = [...groups.entries()]
    .map(([section, sectionPages]) => {
      const items = sectionPages
        .map((page) => {
          const active = current.location === "page" && current.slug === page.slug;
          return `<li><a href="${hrefPrefix}${page.slug}.html"${
            active ? ' aria-current="page"' : ""
          }>${String(page.order).padStart(2, "0")}. ${page.title}</a></li>`;
        })
        .join("");
      const label = SECTION_LABELS[section] ?? section;
      return `<section><h2>${label}</h2><ol>${items}</ol></section>`;
    })
    .join("");

  return `<p class="toc-label">On this site</p><ol>${readmeItem}</ol><div class="sections">${sections}</div>`;
}

function renderHeaderLinks(
  fromPagesDir: boolean,
  current: PageLocation,
  firstPage?: DocPage,
): string {
  const homeCurrent = current === "index" ? ' aria-current="page"' : "";
  const readmeCurrent = current === "readme" ? ' aria-current="page"' : "";
  const docsCurrent = current === "page" ? ' aria-current="page"' : "";
  const home = indexHref(fromPagesDir);
  const readme = pageHref(README_SLUG, fromPagesDir);
  const docs = firstPage ? pageHref(firstPage.slug, fromPagesDir) : readme;
  return `<a href="${home}"${homeCurrent}>Home</a>
    <a href="${readme}"${readmeCurrent}>README</a>
    <a href="${docs}"${docsCurrent}>Docs</a>`;
}

type SequenceContext = { location: PageLocation; slug?: string };

function pageHref(slug: string, fromPagesDir: boolean): string {
  return fromPagesDir ? `${slug}.html` : `pages/${slug}.html`;
}

function indexHref(fromPagesDir: boolean): string {
  return fromPagesDir ? "../index.html" : "index.html";
}

function renderSequenceNav(pages: DocPage[], current: SequenceContext, fromPagesDir: boolean): string {
  const first = pages[0];
  const parts: string[] = [];

  if (current.location === "index") {
    parts.push('<span class="sequence-spacer"></span>');
    parts.push(
      `<a href="${pageHref(README_SLUG, false)}"><span class="label">Start reading</span><span class="title">README →</span></a>`,
    );
  } else if (current.location === "readme") {
    parts.push(
      `<a href="${indexHref(true)}"><span class="label">Previous</span><span class="title">← Home</span></a>`,
    );
    if (first) {
      parts.push(
        `<a href="${pageHref(first.slug, true)}"><span class="label">Next</span><span class="title">${first.title} →</span></a>`,
      );
    }
  } else {
    const index = pages.findIndex((page) => page.slug === current.slug);
    const prev = index > 0 ? pages[index - 1] : undefined;
    const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : undefined;

    if (index === 0) {
      parts.push(
        `<a href="${pageHref(README_SLUG, true)}"><span class="label">Previous</span><span class="title">← README</span></a>`,
      );
    } else if (prev) {
      parts.push(
        `<a href="${pageHref(prev.slug, true)}"><span class="label">Previous</span><span class="title">← ${prev.title}</span></a>`,
      );
    } else {
      parts.push('<span class="sequence-spacer"></span>');
    }

    parts.push(
      `<a class="sequence-readme" href="${pageHref(README_SLUG, true)}"><span class="label">Overview</span><span class="title">README</span></a>`,
    );

    if (next) {
      parts.push(
        `<a href="${pageHref(next.slug, true)}"><span class="label">Next</span><span class="title">${next.title} →</span></a>`,
      );
    } else {
      parts.push('<span class="sequence-spacer"></span>');
    }
  }

  return `<nav class="sequence-nav" aria-label="Page sequence">${parts.join("")}</nav>`;
}

function pageShell(options: {
  title: string;
  body: string;
  nav: string;
  sequenceNav: string;
  assetPrefix: string;
  mermaidScript: string;
  headerLocation: PageLocation;
  firstPage?: DocPage;
}): string {
  const { title, body, nav, sequenceNav, assetPrefix, mermaidScript, headerLocation, firstPage } =
    options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · pi</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${assetPrefix}assets/theme.css">
</head>
<body>
  <header class="site-header">
    <a class="site-brand" href="${assetPrefix}index.html">pi <span>documentation</span></a>
    <nav class="header-links" aria-label="Site">${renderHeaderLinks(assetPrefix === "../", headerLocation, firstPage)}</nav>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="Table of contents"><details class="sidebar-panel" open><summary class="sidebar-summary">Browse docs</summary><nav class="sidebar-nav" aria-label="Pages">${nav}</nav></details></aside>
    <main>${body}${sequenceNav}</main>
  </div>
  <script type="module">
    import mermaid from "${mermaidScript}";
    mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    await mermaid.run({ querySelector: ".mermaid" });
  </script>
</body>
</html>`;
}

function copyMermaidAssets(outDir: string): void {
  const target = join(outDir, "assets", "mermaid");
  mkdirSync(target, { recursive: true });
  cpSync(join(MERMAID_DIST, "dist"), target, { recursive: true });
}

function copyThemeAssets(outDir: string): void {
  const target = join(outDir, "assets");
  mkdirSync(target, { recursive: true });
  cpSync(THEME_CSS, join(target, "theme.css"));
}

function rewriteLinks(html: string, pages: DocPage[]): string {
  const byBasename = new Map(pages.map((page) => [page.filename, page]));
  return html.replace(/href="([^"]+\.md)"/g, (match, target: string) => {
    const filename = basename(target);
    const page = byBasename.get(filename);
    return page ? `href="${page.slug}.html"` : match;
  });
}

function readmeTitle(projectDir: string): string {
  const path = join(projectDir, "README.md");
  if (!existsSync(path)) return "README";
  return titleFromMarkdown(readFileSync(path, "utf8")) ?? "README";
}

export type BuildResult = {
  pages: DocPage[];
  outDir: string;
  readmeBuilt: boolean;
};

/** Write `index.html`, README, one HTML page per sequenced markdown file, and `manifest.json`. */
export async function buildStaticSite(
  projectDir: string,
  outDir = "dist/docs",
  docsDir = "docs",
): Promise<BuildResult> {
  const pages = discoverPages(projectDir, docsDir);
  const absoluteOut = join(projectDir, outDir);
  const pagesDir = join(absoluteOut, "pages");
  mkdirSync(pagesDir, { recursive: true });
  copyMermaidAssets(absoluteOut);
  copyThemeAssets(absoluteOut);

  const mermaidRoot = "./assets/mermaid/mermaid.esm.min.mjs";
  const mermaidPage = "../assets/mermaid/mermaid.esm.min.mjs";
  const readmePath = join(projectDir, "README.md");
  const readmeBuilt = existsSync(readmePath);
  const readmePageTitle = readmeTitle(projectDir);

  const navForIndex = renderNav(pages, "pages/", { location: "index" });
  const navForReadme = renderNav(pages, "", { location: "readme" });

  if (readmeBuilt) {
    const readmeMarkdown = readFileSync(readmePath, "utf8");
    const readmeBody = rewriteLinks(await markdownToHtml(readmeMarkdown), pages);
    const readmeHtml = pageShell({
      title: readmePageTitle,
      body: readmeBody,
      nav: navForReadme,
      sequenceNav: renderSequenceNav(pages, { location: "readme" }, true),
      assetPrefix: "../",
      mermaidScript: mermaidPage,
      headerLocation: "readme",
      firstPage: pages[0],
    });
    writeFileSync(join(pagesDir, `${README_SLUG}.html`), readmeHtml, "utf8");
  }

  for (const page of pages) {
    const markdown = readFileSync(join(projectDir, page.sourcePath), "utf8");
    const body = rewriteLinks(await markdownToHtml(markdown), pages);
    const html = pageShell({
      title: page.title,
      body,
      nav: renderNav(pages, "", { location: "page", slug: page.slug }),
      sequenceNav: renderSequenceNav(pages, { location: "page", slug: page.slug }, true),
      assetPrefix: "../",
      mermaidScript: mermaidPage,
      headerLocation: "page",
      firstPage: pages[0],
    });
    writeFileSync(join(pagesDir, `${page.slug}.html`), html, "utf8");
  }

  const first = pages[0];
  const startHref = readmeBuilt
    ? `pages/${README_SLUG}.html`
    : first
      ? `pages/${first.slug}.html`
      : null;
  const indexBody = [
    '<div class="hero">',
    "<h1>pi documentation</h1>",
    '<p class="lead">A workflow harness for coding agents: personas, guarded tools, checkpoints, and traceability.</p>',
    '<div class="hero-actions">',
    startHref
      ? `<a class="btn btn-primary" href="${startHref}">Start with README</a>`
      : "",
    first && readmeBuilt
      ? `<a class="btn btn-secondary" href="pages/${first.slug}.html">Skip to ${first.title}</a>`
      : first && !readmeBuilt
        ? `<a class="btn btn-primary" href="pages/${first.slug}.html">Start with ${first.title}</a>`
        : "",
    "</div>",
    '<p class="hero-hint">Browse every page in reading order using the sidebar on the left.</p>',
    "</div>",
  ].join("\n");

  writeFileSync(
    join(absoluteOut, "index.html"),
    pageShell({
      title: "pi documentation",
      body: indexBody,
      nav: navForIndex,
      sequenceNav: renderSequenceNav(pages, { location: "index" }, false),
      assetPrefix: "./",
      mermaidScript: mermaidRoot,
      headerLocation: "index",
      firstPage: pages[0],
    }),
    "utf8",
  );

  const manifest = [
    ...(readmeBuilt
      ? [{ order: 0, title: readmePageTitle, source: "README.md", html: `pages/${README_SLUG}.html` }]
      : []),
    ...pages.map((page) => ({
      order: page.order,
      title: page.title,
      source: page.sourcePath,
      html: `pages/${page.slug}.html`,
    })),
  ];

  writeFileSync(join(absoluteOut, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { pages, outDir, readmeBuilt };
}

/** True when every markdown file under `docsDir` uses the sequenced naming scheme. */
export function sequencedDocsComplete(projectDir: string, docsDir = "docs"): boolean {
  const absolute = join(projectDir, docsDir);
  const markdown = walkMarkdownFiles(absolute);
  return markdown.length > 0 && markdown.every((path) => PAGE_PATTERN.test(basename(path)));
}
