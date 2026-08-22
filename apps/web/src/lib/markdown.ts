import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Markdown from ClickUp is other people's input, so it is sanitized, not
 * trusted. Rendering a teammate's task description must not be able to run
 * script in the tab that is holding a live session cookie.
 */
marked.setOptions({ gfm: true, breaks: true });

/**
 * Links inside a mirrored body leave for a new tab.
 *
 * A description is not a web page you navigated to: following a link in one
 * should not throw away the task you were reading. `rel` rides along because
 * `target="_blank"` alone hands the opened page a handle on this one, and this
 * tab is holding a live session cookie. Both attributes are already in
 * ADD_ATTR; this only fills them in, and the hook runs after sanitizing, so it
 * cannot be used to smuggle anything past it.
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noreferrer");
});

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
