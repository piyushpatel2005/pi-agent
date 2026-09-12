// Build-time syntax highlighting for documentation code fences (Shiki).

import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

const BUNDLED_LANGS: BundledLanguage[] = ["bash", "json", "markdown", "yaml"];

const LANG_ALIASES: Record<string, BundledLanguage> = {
  sh: "bash",
  shell: "bash",
  console: "bash",
  yml: "yaml",
  md: "markdown",
};

let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: BUNDLED_LANGS,
    });
  }
  return highlighter;
}

function resolveLanguage(language: string): BundledLanguage | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  const alias = LANG_ALIASES[normalized];
  if (alias) return alias;
  if (BUNDLED_LANGS.includes(normalized as BundledLanguage)) {
    return normalized as BundledLanguage;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainCodeBlock(code: string): string {
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

/** Highlight a fenced code block with light/dark GitHub themes. */
export async function highlightCode(code: string, language: string): Promise<string> {
  const lang = resolveLanguage(language);
  if (!lang) return plainCodeBlock(code);

  const highlighter = await getHighlighter();
  const trimmed = code.replace(/\n$/, "");
  return highlighter.codeToHtml(trimmed, {
    lang,
    themes: {
      light: "github-light",
      dark: "github-dark",
    },
  });
}
