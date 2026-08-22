import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Markdown from ClickUp is other people's input, so it is sanitized, not
 * trusted. Rendering a teammate's task description must not be able to run
 * script in the tab that is holding a live session cookie.
 */
marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(source: string | null | undefined): string {
  if (!source) return "";
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: ["style", "form", "input", "button"],
  });
}
