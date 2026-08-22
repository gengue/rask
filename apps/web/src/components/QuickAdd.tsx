import { createResource, createSignal, type JSX, onMount, Show } from "solid-js";
import { api } from "../lib/api.ts";
import { tasks } from "../lib/store.ts";
import { StatusIcon } from "./StatusIcon.tsx";

/**
 * Quick add: one line, one keystroke away, no dialog.
 *
 * The task is written into the collection optimistically, so it appears in the
 * list before the request leaves the tab. If ClickUp rejects it, the collection
 * rolls the row back on its own.
 */
export function QuickAdd(props: {
  listId: string | null;
  listName: string | null;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = createSignal("");
  let input!: HTMLInputElement;

  // A task created with no status lands in a "No status" bucket nobody wants.
  // The list's first status is what ClickUp itself would have used.
  const [statuses] = createResource(
    () => props.listId,
    (listId) => api.statuses(listId).catch(() => []),
  );
  const initial = () => statuses()?.[0] ?? null;

  onMount(() => input.focus());

  const submit = () => {
    const value = name().trim();
    if (!value || !props.listId) return;

    const status = initial();

    tasks.insert({
      id: `tmp_${crypto.randomUUID()}`,
      customId: null,
      name: value,
      status: status?.status ?? null,
      statusColor: status?.color ?? null,
      statusType: status?.type ?? "open",
      priority: null,
      dueDate: null,
      startDate: null,
      dateUpdated: new Date().toISOString(),
      dateCreated: new Date().toISOString(),
      listId: props.listId,
      spaceId: null,
      parentId: null,
      tags: [],
      url: null,
      listName: props.listName,
      deletedAt: null,
      archived: false,
      assignees: [],
    });

    setName("");
    props.onClose();
  };

  return (
    <div class="fixed inset-0 z-40 flex items-start justify-center pt-[18vh]">
      <button
        type="button"
        aria-label="Cancel"
        class="absolute inset-0 bg-black/55"
        onClick={props.onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        class="floating relative w-[560px] rounded-xl"
      >
        <div class="flex items-center gap-2.5 px-4">
          <Show when={initial()}>
            {(status) => (
              <StatusIcon type={status().type ?? null} color={status().color ?? null} size={15} />
            )}
          </Show>
          <input
            ref={input}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") props.onClose();
              event.stopPropagation();
            }}
            placeholder={props.listId ? "New task…" : "Open a list first"}
            disabled={!props.listId}
            class="h-14 w-full text-[16px] text-ink"
          />
        </div>
        <div class="flex items-center justify-between border-line/80 border-t px-4 py-2.5">
          <span class="truncate text-[11px] text-ink-3">
            <Show when={props.listName} fallback="No list selected">
              {props.listName}
              <Show when={initial()}> · {initial()?.status}</Show>
            </Show>
          </span>
          <span class="text-[11px] text-ink-4">↵ to create · esc to cancel</span>
        </div>
      </div>
    </div>
  );
}
