// Minimal markdown → HTML for the static documentation site.
//
// Not a general-purpose renderer — only what pi's own docs use. Code fences are
// highlighted at build time via Shiki (same engine VitePress and Next.js use).

import { highlightCode } from "./highlight.ts";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

function parseListItem(line: string): { type: "ul" | "ol"; content: string } | null {
  const unordered = line.match(/^[-*]\s+(.*)$/);
  if (unordered) return { type: "ul", content: unordered[1]! };

  const ordered = line.match(/^\d+\.\s+(.*)$/);
  if (ordered) return { type: "ol", content: ordered[1]! };

  return null;
}

function isListItem(line: string): boolean {
  return parseListItem(line) !== null;
}

function isListContinuation(line: string): boolean {
  return line.trim() !== "" && !isListItem(line) && /^ {2,}/.test(line);
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const first = parseListItem(lines[start]!);
  if (!first) return { html: "", next: start };

  const tag = first.type;
  const items: string[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index++;
      break;
    }

    const item = parseListItem(line);
    if (!item || item.type !== tag) break;

    let content = item.content;
    index++;
    while (index < lines.length && isListContinuation(lines[index]!)) {
      content += ` ${lines[index]!.trim()}`;
      index++;
    }
    items.push(`<li>${inlineMarkdown(content)}</li>`);
  }

  return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
}

function renderTable(rows: string[]): string {
  const cells = rows
    .filter((row) => !isTableSeparator(row))
    .map((row) =>
      row
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );

  if (cells.length === 0) return "";

  const [header, ...body] = cells;
  const head = `<thead><tr>${header!.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const rowsHtml = body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table>${head}<tbody>${rowsHtml}</tbody></table>`;
}

/** Convert a markdown document to an HTML fragment. */
export async function markdownToHtml(markdown: string): Promise<string> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const parts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const block: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        block.push(lines[index]!);
        index++;
      }
      const source = block.join("\n").replace(/\n$/, "");
      if (language === "mermaid") {
        parts.push(`<pre class="mermaid">${escapeHtml(source)}</pre>`);
      } else {
        parts.push(await highlightCode(source, language));
      }
      index++;
      continue;
    }

    if (isTableRow(line)) {
      const table: string[] = [];
      while (index < lines.length && isTableRow(lines[index]!)) {
        table.push(lines[index]!);
        index++;
      }
      parts.push(renderTable(table));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      parts.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      index++;
      continue;
    }

    if (line.trim() === "") {
      index++;
      continue;
    }

    if (line.trim() === "---") {
      parts.push("<hr>");
      index++;
      continue;
    }

    if (isListItem(line)) {
      const list = renderList(lines, index);
      parts.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [line];
    index++;
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !lines[index]!.startsWith("#") &&
      !lines[index]!.startsWith("```") &&
      !isTableRow(lines[index]!) &&
      !isListItem(lines[index]!)
    ) {
      paragraph.push(lines[index]!);
      index++;
    }
    parts.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return parts.join("\n");
}
