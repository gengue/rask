import { isPlaceholder, placeholderId } from "@rask/clickup-client/vocabulary";
import { createSignal, For, Index, type JSX, Show } from "solid-js";
import { api, type Checklist, type ChecklistItem, type TaskDetail } from "../lib/api.ts";
import { pushToast } from "../lib/toast.ts";

/**
 * The checklists on a task.
 *
 * A checklist is the smallest useful unit of work in ClickUp and the one people
 * touch most: four boxes, ticked over an afternoon. So the interaction budget
 * here is one click, and the box has to move under the pointer rather than
 * after a round trip — which is why every write below flips the local copy
 * first and hands the server's answer back afterwards.
 *
 * The optimism is layered, not duplicated. This flips the copy on screen; the
 * API writes the mirror and queues an outbox row in one transaction; the worker
 * ships it and, if ClickUp refuses, repairs the mirror and pushes the truth
 * back over SSE with a toast. Nothing here has to know about any of that.
 */
export function Checklists(props: {
  taskId: string;
  checklists: Checklist[];
  /** Replaces the open detail. Every checklist write answers with the whole task. */
  onDetail: (detail: TaskDetail) => void;
  /** Applies a local edit while the request is in flight, and to undo it. */
  onOptimistic: (apply: (current: TaskDetail) => TaskDetail) => TaskDetail | null;
}): JSX.Element {
  const [adding, setAdding] = createSignal(false);

  const empty = () => props.checklists.length === 0;
  const total = () => props.checklists.reduce((n, list) => n + list.items.length, 0);
  const done = () =>
    props.checklists.reduce((n, list) => n + list.items.filter((i) => i.resolved).length, 0);

  /**
   * Applies a change locally, sends it, and puts the old state back if the
   * request never lands.
   *
   * A ClickUp rejection is not this path: by then the request succeeded and the
   * worker owns the repair. This only covers the API being unreachable, where
   * nothing downstream will ever correct the screen.
   */
  const write = async (
    optimistic: (current: TaskDetail) => TaskDetail,
    send: () => Promise<TaskDetail>,
    what: string,
  ) => {
    const before = props.onOptimistic(optimistic);
    try {
      props.onDetail(await send());
    } catch (error) {
      if (before) props.onOptimistic(() => before);
      pushToast({ tone: "error", title: `Could not ${what}`, detail: message(error) });
    }
  };

  const toggle = (list: Checklist, item: ChecklistItem) =>
    write(
      (current) => mapItem(current, list.id, item.id, (i) => ({ ...i, resolved: !i.resolved })),
      () => api.patchChecklistItem(item.id, { resolved: !item.resolved }),
      item.resolved ? "untick the item" : "tick the item",
    );

  const rename = (list: Checklist, item: ChecklistItem, name: string) =>
    write(
      (current) => mapItem(current, list.id, item.id, (i) => ({ ...i, name })),
      () => api.patchChecklistItem(item.id, { name }),
      "rename the item",
    );

  const removeItem = (list: Checklist, item: ChecklistItem) =>
    write(
      (current) => dropItem(current, list.id, item.id),
      () => api.deleteChecklistItem(item.id),
      "delete the item",
    );

  return (
    /* A task with no checklists gets the affordance and nothing else. A
       heading, a rule and an empty body on every task in the workspace is the
       same wall of nothing the custom-field list is careful not to build. */
    <section class="px-5" classList={{ "border-line/70 border-t py-4": !empty(), "pt-3": empty() }}>
      <Show when={!empty()}>
        <h3 class="flex items-baseline gap-1.5 pb-3 font-medium text-xs text-ink-4 uppercase tracking-[0.04em]">
          Checklists
          <Show when={total() > 0}>
            <span class="tabular-nums lowercase">
              {done()}/{total()}
            </span>
          </Show>
        </h3>
      </Show>

      {/*
        Index, not For.

        Every write here replaces the whole detail object, so `For` — which
        keys on reference identity — would tear down the block it belongs to
        and build a new one. That takes the open composer and the caret with
        it, which made adding a second item impossible: the field vanished
        mid-word. Index keys on position and hands the block a signal, so the
        component and its DOM survive the write.
      */}
      <div class="space-y-4">
        <Index each={props.checklists}>
          {(list) => (
            <ChecklistBlock
              list={list()}
              onToggle={(item) => void toggle(list(), item)}
              onRenameItem={(item, name) => void rename(list(), item, name)}
              onRemoveItem={(item) => void removeItem(list(), item)}
              onRename={(name) =>
                void write(
                  (current) => mapList(current, list().id, (l) => ({ ...l, name })),
                  () => api.renameChecklist(list().id, name),
                  "rename the checklist",
                )
              }
              onRemove={() =>
                void write(
                  (current) => ({
                    ...current,
                    checklists: current.checklists.filter((l) => l.id !== list().id),
                  }),
                  () => api.deleteChecklist(list().id),
                  "delete the checklist",
                )
              }
              onAddItem={(name) => {
                const listId = list().id;
                void write(
                  (current) =>
                    mapList(current, listId, (l) => ({
                      ...l,
                      items: [...l.items, draftItem(name)],
                    })),
                  () => api.createChecklistItem(listId, { name, clientId: crypto.randomUUID() }),
                  "add the item",
                );
              }}
            />
          )}
        </Index>
      </div>

      <div classList={{ "pt-3": !empty() }}>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              onClick={() => setAdding(true)}
              class="-mx-1 rounded-[5px] px-1 py-0.5 text-ink-4 text-xs hover:bg-hover hover:text-ink-2"
            >
              + Add checklist
            </button>
          }
        >
          <InlineInput
            placeholder="Checklist name…"
            submitLabel="Add"
            onCancel={() => setAdding(false)}
            onSubmit={(name) => {
              setAdding(false);
              void write(
                (current) => ({
                  ...current,
                  checklists: [...current.checklists, { id: draftId(), name, items: [] }],
                }),
                () => api.createChecklist(props.taskId, { name, clientId: crypto.randomUUID() }),
                "add the checklist",
              );
            }}
          />
        </Show>
      </div>
    </section>
  );
}

/** One checklist: its name, its boxes, and the line that adds another. */
function ChecklistBlock(props: {
  list: Checklist;
  onToggle: (item: ChecklistItem) => void;
  onRenameItem: (item: ChecklistItem, name: string) => void;
  onRemoveItem: (item: ChecklistItem) => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onAddItem: (name: string) => void;
}): JSX.Element {
  const [adding, setAdding] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);

  /** A checklist the outbox has not shipped yet has no id ClickUp would accept. */
  const pending = () => isPlaceholder(props.list.id);
  const done = () => props.list.items.filter((item) => item.resolved).length;

  return (
    <div class="group/list" classList={{ "opacity-50": pending() }}>
      <div class="flex items-center gap-2 pb-1.5">
        <Show
          when={renaming()}
          fallback={
            <>
              <button
                type="button"
                onDblClick={() => !pending() && setRenaming(true)}
                title="Double-click to rename"
                class="cursor-text font-medium text-base text-ink"
              >
                {props.list.name}
              </button>
              <Show when={props.list.items.length > 0}>
                <span class="text-ink-4 text-xs tabular-nums">
                  {done()}/{props.list.items.length}
                </span>
              </Show>
              <div class="flex-1" />
              <Show when={!pending()}>
                <button
                  type="button"
                  onClick={props.onRemove}
                  class="rounded-[4px] px-1 py-0.5 text-ink-4 text-xs opacity-0 hover:bg-hover hover:text-ink-2 focus-visible:opacity-100 group-hover/list:opacity-100"
                >
                  Delete
                </button>
              </Show>
            </>
          }
        >
          <InlineInput
            initial={props.list.name}
            placeholder="Checklist name…"
            submitLabel="Rename"
            onCancel={() => setRenaming(false)}
            onSubmit={(name) => {
              setRenaming(false);
              if (name !== props.list.name) props.onRename(name);
            }}
          />
        </Show>
      </div>

      {/* Progress against a checklist you can already count is not information,
          so the bar only appears once there are enough boxes to lose track of. */}
      <Show when={props.list.items.length > 3}>
        <div class="mb-2 h-[3px] overflow-hidden rounded-full bg-chip">
          <div
            class="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${(done() / props.list.items.length) * 100}%` }}
          />
        </div>
      </Show>

      <ul>
        <For each={props.list.items}>
          {(item) => (
            <Item
              item={item}
              onToggle={() => props.onToggle(item)}
              onRename={(name) => props.onRenameItem(item, name)}
              onRemove={() => props.onRemoveItem(item)}
            />
          )}
        </For>
      </ul>

      <Show when={!pending()} fallback={<p class="pt-1 text-ink-4 text-xs">Syncing…</p>}>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              onClick={() => setAdding(true)}
              class="mt-0.5 rounded-[5px] px-1 py-0.5 text-ink-4 text-xs hover:bg-hover hover:text-ink-2"
            >
              + Add item
            </button>
          }
        >
          <div class="pt-1">
            <InlineInput
              placeholder="Item…"
              submitLabel="Add"
              /* Stays open after a submit: checklist items are written in runs
                 of four, not one at a time. Escape is what closes it. */
              keepOpen
              onCancel={() => setAdding(false)}
              onSubmit={props.onAddItem}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** One box. The whole row is the target, because an 11px checkbox is not one. */
function Item(props: {
  item: ChecklistItem;
  onToggle: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const pending = () => isPlaceholder(props.item.id);

  return (
    <li class="group/item flex items-start gap-2 rounded-[5px] py-[3px] pr-1 hover:bg-hover">
      <Show
        when={editing()}
        fallback={
          <>
            {/* A real checkbox under a drawn one. The native control keeps the
                keyboard, the screen reader and the label association; the
                appearance is ours because a system checkbox is the one macOS
                widget that does not fit this palette. */}
            <span class="relative mt-[2px] flex size-[15px] shrink-0 items-center justify-center">
              <input
                type="checkbox"
                checked={props.item.resolved}
                disabled={pending()}
                aria-label={props.item.name}
                onChange={props.onToggle}
                class="size-[15px] appearance-none rounded-[4px] border transition-colors"
                classList={{
                  "border-accent bg-accent": props.item.resolved,
                  "border-line-strong hover:border-ink-3": !props.item.resolved,
                }}
              />
              <Show when={props.item.resolved}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                  class="pointer-events-none absolute"
                >
                  <path
                    d="M2.5 6.2 4.7 8.4 9.5 3.6"
                    stroke="var(--color-on-accent)"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </Show>
            </span>

            {/* Nested items are indented rather than nested in the DOM: ClickUp
                allows exactly one level, and a flat list with one padding step
                keeps keyboard order and the strike-through honest. */}
            <button
              type="button"
              onDblClick={() => !pending() && setEditing(true)}
              title={pending() ? "Syncing…" : "Double-click to edit"}
              class="min-w-0 flex-1 cursor-text text-left text-base"
              classList={{
                "pl-4": props.item.parentItemId !== null,
                "text-ink-4 line-through": props.item.resolved,
                "text-ink-prose": !props.item.resolved,
                "opacity-50": pending(),
              }}
            >
              {props.item.name}
            </button>

            <Show when={!pending()}>
              <button
                type="button"
                onClick={props.onRemove}
                aria-label={`Delete ${props.item.name}`}
                class="mt-[1px] shrink-0 rounded-[4px] px-1 text-ink-4 text-xs opacity-0 hover:bg-hover hover:text-ink-2 focus-visible:opacity-100 group-hover/item:opacity-100"
              >
                ×
              </button>
            </Show>
          </>
        }
      >
        <div class="flex-1">
          <InlineInput
            initial={props.item.name}
            placeholder="Item…"
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={(name) => {
              setEditing(false);
              if (name !== props.item.name) props.onRename(name);
            }}
          />
        </div>
      </Show>
    </li>
  );
}

/**
 * The one-line text field behind every name on this panel.
 *
 * Keydown is stopped here rather than filtered upstairs, for the same reason
 * the comment composer does it: the shell owns a single global listener and
 * `j`, `k` and `c` are all letters people type.
 */
export function InlineInput(props: {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  /** Clears and stays focused after a submit, for entering several in a row. */
  keepOpen?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  let input!: HTMLInputElement;
  /**
   * True once this field has produced its answer.
   *
   * Enter submits, the parent closes the field, and the unmount blurs it — and
   * a blur with text in the box is itself a submit. It has to be set *before*
   * `onSubmit`, not after: Solid flushes the signal write synchronously, so the
   * blur lands inside that call and the first Enter posted the item twice.
   */
  let settled = false;

  const submit = () => {
    if (settled) return;
    const value = input.value.trim();
    settled = true;
    if (!value) {
      props.onCancel();
      return;
    }
    props.onSubmit(value);
    // Only reopen if the field is still on the page. `onSubmit` may have
    // replaced the subtree it lives in, and a detached input cannot be typed
    // into however hard we focus it.
    if (props.keepOpen && input.isConnected) {
      input.value = "";
      settled = false;
      input.focus();
    }
  };

  return (
    <div class="flex items-center gap-2">
      <input
        type="text"
        value={props.initial ?? ""}
        placeholder={props.placeholder}
        /* Focused by hand, not by the attribute: `autofocus` is ignored when
           the element mounts while the button that opened it still has focus,
           and every keystroke that misses reaches the shell's shortcuts. */
        ref={(element) => {
          input = element;
          queueMicrotask(() => element.focus());
        }}
        onBlur={() => {
          if (settled) return;
          // A blur with something typed is a submit, not a cancel: clicking
          // away from a half-written item and losing it is the worst outcome
          // available here.
          if (input.value.trim() && input.value.trim() !== props.initial) submit();
          else {
            settled = true;
            props.onCancel();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            settled = true;
            input.value = props.initial ?? "";
            props.onCancel();
          }
          event.stopPropagation();
        }}
        class="min-w-0 flex-1 rounded-[5px] border border-line bg-elevated/70 px-2 py-1 text-base focus-within:border-line-strong"
      />
      <button
        type="button"
        onMouseDown={(event) => {
          // The input must not blur before this runs, or the click lands on
          // nothing and the blur handler has already decided the outcome.
          event.preventDefault();
          submit();
        }}
        class="shrink-0 rounded-[5px] bg-accent px-2 py-1 font-medium text-on-accent text-sm"
      >
        {props.submitLabel}
      </button>
    </div>
  );
}

// --- local edits ----------------------------------------------------------

/** Placeholder ids share the server's prefix, so "not sent yet" reads the same. */
function draftId(): string {
  return placeholderId(crypto.randomUUID());
}

function draftItem(name: string): ChecklistItem {
  return { id: draftId(), name, resolved: false, assigneeId: null, parentItemId: null };
}

function mapList(
  detail: TaskDetail,
  listId: string,
  apply: (list: Checklist) => Checklist,
): TaskDetail {
  return {
    ...detail,
    checklists: detail.checklists.map((list) => (list.id === listId ? apply(list) : list)),
  };
}

function mapItem(
  detail: TaskDetail,
  listId: string,
  itemId: string,
  apply: (item: ChecklistItem) => ChecklistItem,
): TaskDetail {
  return mapList(detail, listId, (list) => ({
    ...list,
    items: list.items.map((item) => (item.id === itemId ? apply(item) : item)),
  }));
}

function dropItem(detail: TaskDetail, listId: string, itemId: string): TaskDetail {
  return mapList(detail, listId, (list) => ({
    ...list,
    items: list.items.filter((item) => item.id !== itemId),
  }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
