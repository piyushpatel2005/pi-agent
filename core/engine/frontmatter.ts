// A deliberately small frontmatter parser.
//
// Persona files carry YAML frontmatter, but they only ever need scalars, flat
// lists, and one-level objects. Supporting exactly that subset — and failing
// loudly on anything else — keeps `pi` dependency-free and keeps persona files
// boring, which is what you want from a file that grants capabilities.
//
// Not supported, on purpose: nested blocks, multi-line strings, anchors,
// comments mid-value. If a persona needs those, it is doing too much.

export class FrontmatterError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "FrontmatterError";
    this.line = line;
  }
}

export type Frontmatter = {
  data: Record<string, unknown>;
  body: string;
};

const FENCE = /^---\s*$/;

export function parseFrontmatter(source: string): Frontmatter {
  const lines = source.split(/\r?\n/);

  if (lines[0] === undefined || !FENCE.test(lines[0])) {
    throw new FrontmatterError("expected the file to open with `---`", 1);
  }

  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (close === -1) {
    throw new FrontmatterError("frontmatter is never closed with `---`", lines.length);
  }

  return {
    data: parseBlock(lines.slice(1, close)),
    body: lines.slice(close + 1).join("\n").trim(),
  };
}

function parseBlock(lines: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNumber = i + 2; // +1 for the opening fence, +1 for 1-based

    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    if (raw.startsWith(" ") || raw.startsWith("\t")) {
      throw new FrontmatterError("unexpected indentation; nesting is not supported", lineNumber);
    }

    const separator = raw.indexOf(":");
    if (separator === -1) throw new FrontmatterError(`expected \`key: value\`, got "${raw}"`, lineNumber);

    const key = raw.slice(0, separator).trim();
    if (key === "") throw new FrontmatterError("empty key", lineNumber);
    if (key in data) throw new FrontmatterError(`duplicate key "${key}"`, lineNumber);

    const inline = raw.slice(separator + 1).trim();

    if (inline === "") {
      // A block list: the following `- item` lines belong to this key.
      const items: unknown[] = [];
      while (i + 1 < lines.length && lines[i + 1]!.trimStart().startsWith("- ")) {
        items.push(scalar(lines[++i]!.trimStart().slice(2).trim(), i + 2));
      }

      if (items.length === 0) {
        // An indented line that is not a list item is a nested mapping, which
        // this parser deliberately cannot represent. Say that, rather than the
        // misleading "no value".
        const next = lines[i + 1];
        const nested = next !== undefined && /^[ \t]+\S/.test(next);
        throw new FrontmatterError(
          nested
            ? `key "${key}" opens a nested block; nesting is not supported`
            : `key "${key}" has no value`,
          lineNumber,
        );
      }

      data[key] = items;
      continue;
    }

    data[key] = value(inline, lineNumber);
  }

  return data;
}

function value(raw: string, line: number): unknown {
  if (raw.startsWith("[")) return inlineList(raw, line);
  if (raw.startsWith("{")) return inlineObject(raw, line);
  return scalar(raw, line);
}

function inlineList(raw: string, line: number): unknown[] {
  if (!raw.endsWith("]")) throw new FrontmatterError("unterminated `[`", line);

  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];

  return splitTopLevel(inner, line).map((entry) => scalar(entry, line));
}

function inlineObject(raw: string, line: number): Record<string, unknown> {
  if (!raw.endsWith("}")) throw new FrontmatterError("unterminated `{`", line);

  const inner = raw.slice(1, -1).trim();
  if (inner === "") return {};

  const result: Record<string, unknown> = {};
  for (const entry of splitTopLevel(inner, line)) {
    const separator = entry.indexOf(":");
    if (separator === -1) throw new FrontmatterError(`expected \`key: value\` in "${entry}"`, line);
    result[entry.slice(0, separator).trim()] = scalar(entry.slice(separator + 1).trim(), line);
  }
  return result;
}

/** Split on commas that are not inside quotes or brackets. */
function splitTopLevel(raw: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      parts.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }

  if (quote) throw new FrontmatterError("unterminated quote", line);
  parts.push(raw.slice(start).trim());

  return parts.filter((part) => part !== "");
}

function scalar(raw: string, line: number): unknown {
  if (raw === "") throw new FrontmatterError("empty value", line);

  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    // A quote that never closes would otherwise become a string with a stray
    // leading quote — silently wrong in a file that grants capabilities.
    if (raw.length < 2 || !raw.endsWith(quote)) {
      throw new FrontmatterError("unterminated quote", line);
    }
    return raw.slice(1, -1);
  }

  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);

  return raw;
}
