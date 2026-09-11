import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("buildStaticSite writes index, pages, and manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-docs-"));
    const docs = join(root, "docs", "concepts");
    mkdirSync(docs, { recursive: true });
    writeFileSync(
      join(docs, "01-sample.md"),
      "# Sample\n\nSee [Next](../guides/02-next.md).\n",
    );

    const out = join(root, "site");
    const result = buildStaticSite(root, "site", "docs");

    assert.equal(result.pages.length, 1);
    assert.ok(readFileSync(join(out, "index.html"), "utf8").includes("Sample"));
    assert.ok(readFileSync(join(out, "pages", "01-sample.html"), "utf8").includes("<h1>Sample</h1>"));
    assert.deepEqual(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")), [
      {
        order: 1,
        title: "Sample",
        source: "docs/concepts/01-sample.md",
        html: "pages/01-sample.html",
      },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("mermaid fences become pre.mermaid blocks", () => {
    const html = markdownToHtml("```mermaid\ngraph TD; A-->B\n```");
    assert.match(html, /<pre class="mermaid">graph TD; A--&gt;B<\/pre>/);
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
