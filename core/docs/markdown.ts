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

    const paragraph: string[] = [line];
    index++;
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !lines[index]!.startsWith("#") &&
      !lines[index]!.startsWith("```") &&
      !isTableRow(lines[index]!)
    ) {
      paragraph.push(lines[index]!);
      index++;
    }
    parts.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return parts.join("\n");
}
