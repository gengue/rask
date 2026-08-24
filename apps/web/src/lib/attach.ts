import { encodeUrl, label } from "@rask/clickup-client/comment-body";
import { MAX_ATTACHMENT_BYTES } from "@rask/clickup-client/vocabulary";
import { createSignal } from "solid-js";
import { type AttachmentUpload, api } from "./api.ts";
import { formatBytes } from "./format.ts";
import { pushToast } from "./toast.ts";

/**
 * Sending files to a task, from wherever they were dropped.
 *
 * Two callers share this and want different things from the result. The detail
 * panel wants the refreshed task, because the file becomes a row in the
 * attachments section. The comment composer wants a URL, because the file
 * becomes a markdown link in whatever is being typed.
 *
 * A comment cannot own a file: `POST /task/{id}/comment` takes `comment_text`
 * and nothing else, and the v2 spec has one attachment endpoint, on the task.
 * ClickUp's own client hangs a comment's files off the task as well, so the
 * link is the entire difference between the two cases.
 */

export interface Uploader {
  /** Names currently in flight, oldest first. Empty when nothing is uploading. */
  pending: () => string[];
  /** True while a file is being dragged over this uploader's element. */
  dragging: () => boolean;
  upload: (files: File[]) => Promise<void>;
  /**
   * Drag handlers to spread onto the element that accepts files.
   *
   * Both drop targets are live at once — the composer sits inside the panel —
   * so the inner one claims a drop by preventing the default and the outer one
   * stands down when it sees that. The same rule keeps a file dropped on the
   * open description from being uploaded behind CodeMirror's back: its own drop
   * handler reads the file into the text and prevents the default too.
   */
  handlers: {
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
}

export function createUploader(input: {
  taskId: () => string;
  onUploaded: (result: AttachmentUpload, file: File, taskId: string) => void;
}): Uploader {
  const [inFlight, setInFlight] = createSignal<File[]>([]);
  const [dragging, setDragging] = createSignal(false);

  /*
   * One at a time, not `Promise.all`.
   *
   * Every upload is followed by the server re-reading the task, so three at
   * once is three ClickUp round trips racing to write the same attachment rows
   * out of one person's rate budget. Two separate drops still overlap; this is
   * about not making one drop of eight screenshots the common case.
   */
  const upload = async (files: File[]): Promise<void> => {
    // Read once. The panel does not remount when you open a different task, so
    // by the third file of a drop this can be answering for somebody else.
    const taskId = input.taskId();

    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        pushToast({
          tone: "error",
          title: `${file.name} is too large`,
          detail: `Files are limited to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        });
        continue;
      }

      setInFlight((files) => [...files, file]);
      try {
        input.onUploaded(await api.uploadAttachment(taskId, file), file, taskId);
      } catch (error) {
        pushToast({
          tone: "error",
          title: `Could not upload ${file.name}`,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // By identity: two drops of the same file on disk are two File objects,
        // so this cannot clear an entry that belongs to the other one.
        setInFlight((files) => files.filter((inFlight) => inFlight !== file));
      }
    }
  };

  const handlers = {
    onDragOver: (event: DragEvent) => {
      // Somebody nearer the file has taken it.
      if (event.defaultPrevented) return;
      // `dataTransfer.files` is empty until the drop lands; during a drag the
      // type list is all the browser will say.
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      // Fires for every child crossed on the way through, so only a pointer
      // that has actually left counts. A textarea has no children and always
      // has, which is the same answer.
      const target = event.currentTarget as Node | null;
      if (!target?.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      setDragging(false);
      if (event.defaultPrevented) return;
      const files = filesFrom(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      void upload(files);
    },
  };

  return { pending: () => inFlight().map((file) => file.name), dragging, upload, handlers };
}

/** The files carried by a drop, a paste, or a file input. A pasted screenshot is one. */
export function filesFrom(source: { files: FileList | null } | null | undefined): File[] {
  return source?.files ? [...source.files] : [];
}

/**
 * How an uploaded file reads inside a comment.
 *
 * An image is worth seeing, so it is embedded and points at `url`, which is
 * what an `<img>` loads. Anything else is a link to `urlWithQuery`, the variant
 * the CDN opens in the tab instead of dropping in Downloads — the same
 * distinction the attachments section makes.
 *
 * Both halves are escaped by the same helpers that render ClickUp's own
 * comments back to markdown: a filename holding a bracket ends the link text
 * early, and a space in the URL ends the destination early and points the link
 * somewhere else entirely.
 */
export function attachmentMarkdown(file: File, uploaded: AttachmentUpload["attachment"]): string {
  const image = file.type.startsWith("image/");
  const href = image
    ? (uploaded.url ?? uploaded.urlWithQuery)
    : (uploaded.urlWithQuery ?? uploaded.url);
  return `${image ? "!" : ""}[${label(uploaded.title || file.name)}](${encodeUrl(href ?? "")})`;
}
