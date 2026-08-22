import { createSignal, type JSX, onMount, Show } from "solid-js";
import { tasks } from "../lib/store.ts";

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

  onMount(() => input.focus());

  const submit = () => {
    const value = name().trim();
    if (!value || !props.listId) return;

    tasks.insert({
      id: `tmp_${crypto.randomUUID()}`,
      customId: null,
      name: value,
      status: null,
      statusColor: null,
      statusType: "open",
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
    <div class="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-[18vh]">
      <div class="floating w-[560px] rounded-xl" onClick={(event) => event.stopPropagation()}>
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
          class="h-12 w-full px-4 text-[15px] text-ink"
        />
        <div class="flex items-center justify-between border-line/80 border-t px-4 py-2">
          <span class="truncate text-[11px] text-ink-4">
            <Show when={props.listName} fallback="No list selected">
              Adding to {props.listName}
            </Show>
          </span>
          <span class="text-[11px] text-ink-4">↵ to create · esc to cancel</span>
        </div>
      </div>
    </div>
  );
}
