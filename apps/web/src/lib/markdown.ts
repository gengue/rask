import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Markdown from ClickUp is other people's input, so it is sanitized, not
 * trusted. Rendering a teammate's task description must not be able to run
 * script in the tab that is holding a live session cookie.
 */
marked.setOptions({ gfm: true, breaks: true });

/** `@[Name](clickup://user/123)` → a chip, before markdown sees it as a link. */
const MENTION = /@\[([^\]]+)\]\(clickup:\/\/user\/(\d+)\)/g;

export function renderMarkdown(source: string | null | undefined): string {
  if (!source) return "";

  // Escaped, because the display name comes from ClickUp and lands in HTML.
  // DOMPurify runs after this and would catch it anyway; not relying on that.
  const withMentions = source.replace(MENTION, (_match, name: string) => {
    const safe = String(name).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
    return `<span class="rask-mention">@${safe}</span>`;
  });

  const html = marked.parse(withMentions, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: ["style", "form", "input", "button"],
  });
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
