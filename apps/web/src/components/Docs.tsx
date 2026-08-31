import { createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { api, type Doc } from "../lib/api.ts";
import { formatRelative } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { reconcileStorage } from "../lib/reconcile-storage.ts";
import { heldValue } from "../lib/resource.ts";

/**
 * The Docs written inside a task.
 *
 * Collapsed and unfetched until asked for, exactly like the time log above it
 * and for the same two reasons: a Doc is long enough to bury the conversation
 * under it, and reading one costs real requests out of the viewer's own
 * 100/min — a search plus one per Doc — which is not a bill to charge every
 * task anybody opens. Most tasks have no Docs at all, and there is no way to
 * know that without asking.
 */
export function Docs(props: { taskId: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);

  const [docs] = createResource(
    () => (open() ? props.taskId : null),
    (id) => api.taskDocs(id).then((r) => r.docs),
    // Reconciled rather than replaced, as the time log is: `<For>` keys by
    // reference, so a plain refetch rebuilds every rendered page.
    { storage: reconcileStorage },
  );

  // Another task is another set of Docs. Fold back on the way in, or expanding
  // on task B replays A's for the length of B's round trip.
  createEffect(() => {
    props.taskId;
    setOpen(false);
  });

  /*
   * `heldValue`, never `docs()`. This resource talks to ClickUp: an expired
   * token answers 409 and a plain read would throw that up to the router's
   * boundary and take the whole panel down. The section says it failed; the
   * task survives.
   */
  const rows = () => heldValue(docs) ?? [];
  const failed = () => docs.state === "errored";

  return (
    <section class="border-line/70 border-t px-5 py-4">
      <h3 class="flex items-baseline pb-3 font-medium text-xs text-ink-4">
        <button
          type="button"
          onClick={() => setOpen(!open())}
          aria-expanded={open()}
          class="flex items-baseline gap-1.5 uppercase tracking-[0.04em] hover:text-ink-2"
        >
          <span aria-hidden="true" class="inline-block w-2 text-[9px]">
            {open() ? "▾" : "▸"}
          </span>
          Docs
          <Show when={open() && rows().length > 0}>
            <span class="tabular-nums lowercase">{rows().length}</span>
          </Show>
        </button>
      </h3>

      <Show when={open()}>
        <Show
          when={rows().length > 0 || docs.loading}
          fallback={
            <p class="text-ink-4 text-xs">
              {failed() ? "Could not read Docs from ClickUp." : "No Docs on this task."}
            </p>
          }
        >
          <ul class="space-y-4">
            <For each={rows()}>{(doc) => <DocBody doc={doc} />}</For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

function DocBody(props: { doc: Doc }): JSX.Element {
  /*
   * A page heading only when there is more than one page.
   *
   * A one-page Doc names its page after itself — both came back as "FLIGHTS
   * INBOX TASK SAS/SES STATUS QUO" — and printing the same words twice, once
   * as the Doc and once as its only page, reads like a rendering bug.
   */
  const many = () => props.doc.pages.length > 1;

  return (
    <li>
      <h4 class="flex items-baseline gap-2 pb-1 font-medium text-ink-2 text-md">
        <span class="min-w-0 truncate">{props.doc.name}</span>
        <Show when={props.doc.updated}>
          {(updated) => (
            <span class="shrink-0 text-ink-4 text-xs">{formatRelative(updated())}</span>
          )}
        </Show>
      </h4>

      <For each={props.doc.pages}>
        {(page) => (
          <div classList={{ "pt-2": many() }}>
            <Show when={many()}>
              <h5 class="pb-0.5 font-medium text-ink-3 text-xs">{page.name}</h5>
            </Show>
            <Show
              when={page.content}
              fallback={<p class="text-ink-4 text-xs">This page is empty.</p>}
            >
              {/* Sanitized in renderMarkdown. A Doc is other people's input and
                  never reaches the DOM raw. */}
              <div
                class="prose-rask selectable text-base"
                innerHTML={renderMarkdown(page.content)}
              />
            </Show>
          </div>
        )}
      </For>
    </li>
  );
}
