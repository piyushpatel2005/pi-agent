import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FrontmatterError, parseFrontmatter } from "../../core/engine/frontmatter.ts";

function fm(...lines: string[]): ReturnType<typeof parseFrontmatter> {
  return parseFrontmatter(lines.join("\n"));
}

describe("parseFrontmatter", () => {
  test("splits frontmatter from body", () => {
    const { data, body } = fm("---", "id: thing", "---", "", "The body.", "");
    assert.deepEqual(data, { id: "thing" });
    assert.equal(body, "The body.");
  });

  test("keeps structure inside the body", () => {
    const { body } = fm("---", "id: a", "---", "# Title", "", "para", "", "- item");
    assert.equal(body, "# Title\n\npara\n\n- item");
  });

  test("a `---` inside the body does not confuse the split", () => {
    const { data, body } = fm("---", "id: a", "---", "before", "---", "after");
    assert.deepEqual(data, { id: "a" });
    assert.match(body, /^before\n---\nafter$/);
  });

  test("reads inline lists", () => {
    assert.deepEqual(fm("---", "tools: [read, write-code]", "---", "b").data, {
      tools: ["read", "write-code"],
    });
  });

  test("reads an empty inline list", () => {
    assert.deepEqual(fm("---", "tools: []", "---", "b").data, { tools: [] });
  });

  test("reads block lists", () => {
    const { data } = fm("---", "knowledge:", "  - a.md", "  - b.md", "---", "b");
    assert.deepEqual(data, { knowledge: ["a.md", "b.md"] });
  });

  test("reads inline objects", () => {
    assert.deepEqual(fm("---", "budget: { maxFiles: 8, maxLines: 300 }", "---", "b").data, {
      budget: { maxFiles: 8, maxLines: 300 },
    });
  });

  test("types scalars", () => {
    const { data } = fm(
      "---",
      "count: 8",
      "ratio: 1.5",
      "yes: true",
      "no: false",
      "nothing: null",
      "word: hello",
      "---",
      "b",
    );
    assert.deepEqual(data, {
      count: 8,
      ratio: 1.5,
      yes: true,
      no: false,
      nothing: null,
      word: "hello",
    });
  });

  test("quotes protect a value that would otherwise be coerced", () => {
    const { data } = fm("---", 'version: "8"', "desc: 'a: colon'", "---", "b");
    assert.deepEqual(data, { version: "8", desc: "a: colon" });
  });

  test("an unquoted value may contain colons", () => {
    assert.equal(fm("---", "description: Does a thing: carefully.", "---", "b").data.description, "Does a thing: carefully.");
  });

  test("skips blank lines and comments", () => {
    const { data } = fm("---", "# a note", "", "id: a", "---", "b");
    assert.deepEqual(data, { id: "a" });
  });

  test("rejects a file with no frontmatter", () => {
    assert.throws(() => parseFrontmatter("just text"), FrontmatterError);
  });

  test("rejects unclosed frontmatter", () => {
    assert.throws(() => parseFrontmatter("---\nid: a\n"), /never closed/);
  });

  test("rejects nesting, which it cannot represent", () => {
    assert.throws(() => fm("---", "a:", "  b: 1", "---", "x"), /nesting is not supported/);
  });

  test("rejects a duplicate key rather than silently taking one", () => {
    assert.throws(() => fm("---", "id: a", "id: b", "---", "x"), /duplicate key/);
  });

  test("rejects a key with no value", () => {
    assert.throws(() => fm("---", "id:", "---", "x"), /no value/);
  });

  test("rejects an unterminated list or quote", () => {
    assert.throws(() => fm("---", "tools: [a, b", "---", "x"), /unterminated/);
    assert.throws(() => fm("---", 'name: "unclosed', "---", "x"), /unterminated/);
  });

  test("reports the line a problem is on", () => {
    try {
      fm("---", "id: a", "broken line", "---", "x");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof FrontmatterError);
      assert.equal(error.line, 3);
    }
  });
});
