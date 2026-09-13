import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { markdownToHtml } from "../../core/docs/markdown.ts";
import { buildStaticSite, discoverPages } from "../../core/docs/site.ts";

describe("docs site", () => {
  test("discoverPages sorts by numeric prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-docs-"));
    const docs = join(root, "docs", "guides");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "05-second.md"), "# Second\n");
    writeFileSync(join(docs, "04-first.md"), "# First\n");

    const pages = discoverPages(root, "docs");
    assert.deepEqual(
      pages.map((page) => page.order),
      [4, 5],
    );
    assert.equal(pages[0]!.title, "First");
    rmSync(root, { recursive: true, force: true });
  });

  test("buildStaticSite writes index, readme, pages, theme, and manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-docs-"));
    const docs = join(root, "docs", "concepts");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(root, "README.md"), "# Project README\n\nWelcome.\n");
    writeFileSync(
      join(docs, "01-sample.md"),
      "# Sample\n\nSee [Next](../guides/02-next.md).\n",
    );

    const out = join(root, "site");
    const result = await buildStaticSite(root, "site", "docs");

    assert.equal(result.pages.length, 1);
    assert.equal(result.readmeBuilt, true);
    assert.ok(existsSync(join(out, "assets", "theme.css")));
    assert.ok(readFileSync(join(out, "index.html"), "utf8").includes("hero"));
    assert.ok(readFileSync(join(out, "pages", "readme.html"), "utf8").includes("<h1>Project README</h1>"));
    assert.ok(readFileSync(join(out, "pages", "01-sample.html"), "utf8").includes("<h1>Sample</h1>"));
    assert.match(readFileSync(join(out, "pages", "01-sample.html"), "utf8"), /← README/);
    assert.match(readFileSync(join(out, "pages", "readme.html"), "utf8"), /Sample →/);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")), [
      {
        order: 0,
        title: "Project README",
        source: "README.md",
        html: "pages/readme.html",
      },
      {
        order: 1,
        title: "Sample",
        source: "docs/concepts/01-sample.md",
        html: "pages/01-sample.html",
      },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("mermaid fences become pre.mermaid blocks", async () => {
    const html = await markdownToHtml("```mermaid\ngraph TD; A-->B\n```");
    assert.match(html, /<pre class="mermaid">graph TD; A--&gt;B<\/pre>/);
  });

  test("code fences are syntax-highlighted with Shiki", async () => {
    const html = await markdownToHtml('```bash\necho hello\n```');
    assert.match(html, /<pre class="shiki/);
    assert.match(html, /echo/);
  });

  test("unordered lists render with wrapped items", async () => {
    const html = await markdownToHtml(
      "- **Seven personas** — analyst,\n  architect, engineer.\n- **Router.** Next step.\n",
    );
    assert.match(html, /<ul><li><strong>Seven personas<\/strong>/);
    assert.match(html, /architect, engineer\./);
    assert.match(html, /<li><strong>Router\.<\/strong> Next step\.<\/li><\/ul>/);
  });

  test("ordered lists render numbered items", async () => {
    const html = await markdownToHtml("1. First step.\n2. Second step.\n");
    assert.equal(html, "<ol><li>First step.</li><li>Second step.</li></ol>");
  });

  test("ignores markdown files without a sequence prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-docs-"));
    const docs = join(root, "docs-only");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "readme.md"), "# No prefix\n");

    assert.deepEqual(discoverPages(root, "docs-only"), []);
    rmSync(root, { recursive: true, force: true });
  });
});
