import { formatMention } from "@rask/clickup-client/mentions";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  type Assignee,
  api,
  type Comment,
  type CommentThread,
  type Task,
  type TaskDetail as TaskDetailData,
} from "../lib/api.ts";
import { formatDue, formatRelative, PRIORITY_LABELS } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { applyMention, type MentionQuery, mentionQueryAt } from "../lib/mention-query.ts";
import { me, members } from "../lib/session.ts";
import { pushedDetail } from "../lib/sse.ts";
import { tasks } from "../lib/store.ts";
import { pushToast } from "../lib/toast.ts";
import { setUi, ui } from "../lib/ui.ts";
import { Attachments } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { Checklists } from "./Checklists.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { PriorityIcon, StatusIcon } from "./StatusIcon.tsx";
import { ParentLink, Subtasks } from "./Subtasks.tsx";

/**
 * The detail panel.
 *
 * Two columns like the reference: the task itself on the left, its properties
 * on the right. Properties are a plain label/value list rather than a form,
 * because in a keyboard-first app they are read far more often than edited and
 * a wall of inputs reads as noise.
 */
export function TaskDetail(props: {
  taskId: string;
  onClose: () => void;
  onStatusClick: (event: MouseEvent) => void;
}): JSX.Element {
  const [detail, { mutate, refetch }] = createResource(
    () => props.taskId,
    (id) => api.task(id),
  );

  /**
   * The collection is the source of truth for anything the list also shows.
   *
   * Without this the panel would keep rendering the fetched snapshot, so
   * changing status from the list would move the row and leave the open detail
   * claiming the old value. The resource still supplies what only it knows:
   * description, comments and custom fields.
   */
  const task = () => {
    const fetched = detail();
    if (!fetched) return null;
    const live = tasks.get(props.taskId);
    return live ? { ...fetched, ...live } : fetched;
  };

  const [assigneeMenu, setAssigneeMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [priorityMenu, setPriorityMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [tagMenu, setTagMenu] = createSignal<{ x: number; y: number } | null>(null);

  /**
   * The Space's whole tag set, fetched when the menu opens.
   *
   * Not from the mirror: the picker needs tags nobody has used yet, and the
   * mirror only knows the ones already on a task.
   */
  const [spaceTags] = createResource(
    () => (tagMenu() ? (task()?.spaceId ?? null) : null),
    (spaceId) => api.spaceTags(spaceId).catch(() => []),
  );
  const [editingDescription, setEditingDescription] = createSignal(false);

  /** Optimistic edit of the open task. The collection rolls it back on failure. */
  const patch = (apply: (draft: Task) => void) => tasks.update(props.taskId, apply);

  /**
   * Optimistic edit of what only the detail knows.
   *
   * Checklists and subtasks are not in the task collection — carrying them
   * would mean fetching every one for a 500-row list — so there is nothing for
   * `tasks.update` to roll back. Returning the previous detail hands the caller
   * its own undo instead.
   */
  const optimistic = (
    apply: (current: TaskDetailData) => TaskDetailData,
  ): TaskDetailData | null => {
    const before = detail();
    if (!before) return null;
    mutate(apply(before));
    return before;
  };

  // The SSE feed writes refreshed rows into the collection. When the open task
  // is one of them, pull the fuller detail again so comments stay live.
  createEffect(() => {
    const row = tasks.get(props.taskId);
    if (row && detail() && row.dateUpdated !== detail()?.dateUpdated) void refetch();
  });

  // `GET /tasks/:id` refreshes from ClickUp in the background and pushes the
  // result back over SSE. This is where that push lands.
  createEffect(() => {
    const pushed = pushedDetail();
    if (pushed?.id === props.taskId) mutate(pushed);
  });

  /**
   * Keeps the open conversation moving.
   *
   * Comments are the one part of a task that changes while someone is staring
   * at it, and the list poll that carries everything else runs every five
   * minutes. Asking again costs the viewer's own token two ClickUp requests a
   * minute out of its own hundred, and it scales with people looking rather
   * than with the seventeen thousand tasks nobody has open. A hidden tab is
   * not looking, so it does not ask.
   */
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") void refetch();
  }, 30_000);
  onCleanup(() => clearInterval(timer));

  return (
    <aside
      aria-label="Task detail"
      class="flex flex-col bg-panel"
      classList={{
        "w-[420px] shrink-0 border-line border-l": !ui.taskExpanded,
        "flex-1 min-w-0": ui.taskExpanded,
      }}
    >
      <header class="flex h-12 shrink-0 items-center gap-2 border-line/70 border-b px-4">
        <Show when={task()?.customId}>
          <span class="font-mono text-ink-3 text-xs">{task()?.customId}</span>
        </Show>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => setUi("taskExpanded", !ui.taskExpanded)}
          title={ui.taskExpanded ? "Collapse  f" : "Expand  f"}
          aria-label={ui.taskExpanded ? "Collapse task" : "Expand task"}
          class="flex size-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <g
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <Show
                when={ui.taskExpanded}
                fallback={<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />}
              >
                <path d="M13 3 9.5 6.5M9.5 6.5V3m0 3.5H13M3 13l3.5-3.5M6.5 9.5V13m0-3.5H3" />
              </Show>
            </g>
          </svg>
        </button>
        <Show when={task()?.url}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noreferrer"
              title="Open in ClickUp"
              class="flex size-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-ink"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" role="img">
                <title>Open in ClickUp</title>
                <g
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7A1.5 1.5 0 0 0 12.5 12V9.5M9 2.5h4.5V7M13 3 7.5 8.5" />
                </g>
              </svg>
            </a>
          )}
        </Show>
        <button
          type="button"
          onClick={props.onClose}
          title="Close  Esc"
          class="flex size-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="m4 4 8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <Show when={task()} fallback={<div class="p-5 text-ink-4 text-xs">Loading…</div>}>
        {/*
         * Expanded, this becomes the two columns the panel always claimed to
         * have: the task on the left at a readable measure, its properties on
         * the right. Placement is grid columns rather than a wrapper, so the
         * children keep their order and the collapsed panel is untouched.
         */}
        {(task) => (
          <div
            class="flex-1 overflow-y-auto"
            classList={{
              // Three explicit rows — title, description, comments — so the
              // properties rail can span all of them. Without that, the rail
              // sizes row one and leaves a hole under the title.
              "grid grid-cols-[minmax(0,680px)_300px] grid-rows-[auto_auto_1fr] justify-center content-start gap-x-12 px-10 pb-24":
                ui.taskExpanded,
            }}
          >
            <div class="px-5 pt-5 pb-4" classList={{ "col-start-1 px-0 pt-8": ui.taskExpanded }}>
              <ParentLink parent={task().parent} />
              <TitleField
                value={task().name}
                onCommit={(name) => {
                  mutate((current) => (current ? { ...current, name } : current));
                  tasks.update(props.taskId, (draft) => {
                    draft.name = name;
                  });
                }}
              />
            </div>

            <div
              class="space-y-px px-3 pb-4"
              classList={{
                "col-start-2 row-start-1 row-span-3 self-start px-0 pt-8": ui.taskExpanded,
              }}
            >
              <Property label="Status">
                <button
                  type="button"
                  aria-label={`Status: ${task().status ?? "none"}`}
                  onClick={props.onStatusClick}
                  class="-mx-1.5 flex h-6 items-center gap-2 rounded-[5px] px-1.5 hover:bg-hover"
                >
                  <StatusIcon type={task().statusType} color={task().statusColor} />
                  <span class="text-base text-ink capitalize">{task().status ?? "None"}</span>
                </button>
              </Property>

              <Property label="Priority">
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setPriorityMenu({ x: rect.left, y: rect.bottom + 6 });
                  }}
                  class="-mx-1.5 flex h-6 w-full items-center gap-2 rounded-[5px] px-1.5 text-left hover:bg-hover"
                >
                  <PriorityIcon priority={task().priority} />
                  <span class="text-base text-ink-2">
                    {task().priority ? PRIORITY_LABELS[task().priority ?? 0] : "None"}
                  </span>
                </button>
              </Property>

              <Property label="Assignees">
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAssigneeMenu({ x: rect.left, y: rect.bottom + 6 });
                  }}
                  class="-mx-1.5 flex h-6 w-full items-center gap-2 rounded-[5px] px-1.5 text-left hover:bg-hover"
                >
                  <Show
                    when={task().assignees.length > 0}
                    fallback={<span class="text-base text-ink-4">Unassigned</span>}
                  >
                    <For each={task().assignees}>
                      {(user) => (
                        <span class="flex items-center gap-1.5">
                          <Avatar user={user} size={17} />
                          <span class="text-base text-ink-2">{user.username}</span>
                        </span>
                      )}
                    </For>
                  </Show>
                </button>
              </Property>

              <Property label="Due">
                <DueField
                  value={task().dueDate}
                  onChange={(iso) =>
                    patch((draft) => {
                      draft.dueDate = iso;
                    })
                  }
                />
              </Property>

              <Property label="Tags">
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTagMenu({ x: rect.left, y: rect.bottom + 6 });
                  }}
                  class="-mx-1.5 flex h-6 w-full items-center gap-1 rounded-[5px] px-1.5 text-left hover:bg-hover"
                >
                  <Show
                    when={task().tags.length > 0}
                    fallback={<span class="text-base text-ink-4">Add…</span>}
                  >
                    <For each={task().tags}>
                      {(tag) => (
                        <span
                          class="rounded-[4px] border px-1.5 py-px text-xs leading-4 text-ink-2"
                          style={{
                            "border-color": `${tag.bg ?? "var(--color-line-strong)"}55`,
                            background: `${tag.bg ?? "transparent"}24`,
                          }}
                        >
                          {tag.name}
                        </span>
                      )}
                    </For>
                  </Show>
                </button>
              </Property>

              <Property label="List">
                <span class="flex h-6 items-center truncate text-base text-ink-2">
                  {task().listName ?? "—"}
                </span>
              </Property>

              <CustomFields
                taskId={props.taskId}
                fields={task().customFields}
                onChanged={() => void refetch()}
              />
            </div>

            <section
              class="border-line/70 border-t px-5 py-4"
              classList={{ "col-start-1 border-t-0 px-0 pt-0": ui.taskExpanded }}
            >
              <Show
                when={editingDescription()}
                fallback={
                  <button
                    type="button"
                    onClick={() => setEditingDescription(true)}
                    class="-mx-2 block w-full cursor-text rounded-md px-2 py-1 text-left hover:bg-hover"
                  >
                    <Show
                      when={task().description}
                      fallback={<span class="text-base text-ink-4">Add a description…</span>}
                    >
                      {/* Sanitized in renderMarkdown. ClickUp descriptions are
                          other people's input and never reach the DOM raw. */}
                      <div
                        class="prose-rask selectable text-base"
                        innerHTML={renderMarkdown(task().description)}
                      />
                    </Show>
                  </button>
                }
              >
                <MarkdownEditor
                  value={task().description ?? ""}
                  autofocus
                  onCancel={() => setEditingDescription(false)}
                  onCommit={(description) => {
                    setEditingDescription(false);
                    // The description is not in the task collection: carrying
                    // it would mean fetching every body for a 500-row list.
                    // Show it locally and send it straight to the API.
                    mutate((current) => (current ? { ...current, description } : current));
                    void api.patchTask(props.taskId, { description });
                  }}
                />
                <div class="pt-2 text-xs text-ink-4">⌘↵ to save · esc to cancel</div>
              </Show>
            </section>

            {/* Inside the comments row rather than beside it: expanded, this
                container is a grid whose third row is the one that stretches,
                and a fourth child would push the conversation to the bottom of
                the panel. */}
            <div classList={{ "col-start-1": ui.taskExpanded }}>
              <Attachments items={task().attachments} />

              <Checklists
                taskId={props.taskId}
                checklists={task().checklists}
                onDetail={(next) => mutate(next)}
                onOptimistic={optimistic}
              />

              <Subtasks task={task()} onOptimistic={optimistic} onRefresh={() => void refetch()} />

              <Comments
                taskId={props.taskId}
                threads={task().comments}
                onDetail={(next) => mutate(next)}
              />
            </div>
          </div>
        )}
      </Show>

      <Show when={assigneeMenu()}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            placeholder="Assign to…"
            items={[
              { id: "", label: "Clear all" },
              ...members().map((user) => ({
                id: user.id,
                label: user.username ?? user.id,
                // A checkmark, because this menu toggles rather than replaces
                // and there is otherwise no way to see who is already on it.
                hint: task()?.assignees.some((a) => a.id === user.id) ? "✓" : "",
                icon: <Avatar user={user} size={16} />,
              })),
            ]}
            onSelect={(id) => {
              setAssigneeMenu(null);
              // Toggle, not replace. Picking a name used to drop everyone else,
              // so assigning yourself quietly unassigned whoever you pair with.
              if (!id) {
                patch((draft) => {
                  draft.assignees = [];
                });
                return;
              }
              const picked = members().find((user) => user.id === id);
              if (!picked) return;
              patch((draft) => {
                draft.assignees = draft.assignees.some((user) => user.id === id)
                  ? draft.assignees.filter((user) => user.id !== id)
                  : [...draft.assignees, toAssignee(picked)];
              });
            }}
            onClose={() => setAssigneeMenu(null)}
          />
        )}
      </Show>

      <Show when={priorityMenu()}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            width={200}
            placeholder="Set priority…"
            items={[
              ...[1, 2, 3, 4].map((level) => ({
                id: String(level),
                label: PRIORITY_LABELS[level] ?? String(level),
                icon: <PriorityIcon priority={level} />,
              })),
              { id: "none", label: "No priority", icon: <PriorityIcon priority={null} /> },
            ]}
            onSelect={(id) => {
              setPriorityMenu(null);
              patch((draft) => {
                draft.priority = id === "none" ? null : Number(id);
              });
            }}
            onClose={() => setPriorityMenu(null)}
          />
        )}
      </Show>

      <Show when={tagMenu()}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            width={240}
            placeholder="Add or remove a tag…"
            items={(spaceTags() ?? []).map((tag) => ({
              id: tag.name,
              label: tag.name,
              // Toggles, so say which ones are already on.
              hint: task()?.tags.some((t) => t.name === tag.name) ? "✓" : "",
            }))}
            onSelect={(name) => {
              setTagMenu(null);
              const current = task()?.tags.map((tag) => tag.name) ?? [];
              const next = current.includes(name)
                ? current.filter((tag) => tag !== name)
                : [...current, name];
              patch((draft) => {
                draft.tags = next.map(
                  (tagName) =>
                    task()?.tags.find((tag) => tag.name === tagName) ?? {
                      name: tagName,
                      fg: null,
                      bg: null,
                    },
                );
              });
              void api.setTags(props.taskId, next).catch((error) => {
                pushToast({ tone: "error", title: "Could not set tags", detail: message(error) });
              });
            }}
            onClose={() => setTagMenu(null)}
          />
        )}
      </Show>
    </aside>
  );
}

function toAssignee(user: Assignee): Assignee {
  return {
    id: user.id,
    username: user.username,
    initials: user.initials,
    color: user.color,
    avatar: user.avatar,
  };
}

/**
 * Native date input. `<input type="date">` already knows the user's locale,
 * their keyboard, and how to open a calendar; a picker component would be a
 * few hundred lines that knows less.
 */
function DueField(props: {
  value: string | null;
  onChange: (iso: string | null) => void;
}): JSX.Element {
  const asInput = () => (props.value ? new Date(props.value).toISOString().slice(0, 10) : "");
  const label = () => formatDue(props.value);

  return (
    <label class="-mx-1.5 relative flex h-6 cursor-default items-center rounded-[5px] px-1.5 hover:bg-hover">
      <span
        class="text-base"
        classList={{
          "text-urgent": label()?.tone === "overdue",
          "text-ink-2": label() != null && label()?.tone !== "overdue",
          "text-ink-4": label() == null,
        }}
      >
        {label()?.text ?? "No due date"}
      </span>
      <input
        type="date"
        value={asInput()}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          // Noon local keeps the date from sliding a day either way once
          // ClickUp stores it as an instant and someone reads it elsewhere.
          props.onChange(raw ? new Date(`${raw}T12:00:00`).toISOString() : null);
        }}
        class="absolute inset-0 cursor-default opacity-0"
        aria-label="Due date"
      />
    </label>
  );
}

/**
 * Custom fields, minus the noise.
 *
 * A real ClickUp list carries a dozen of them and most are empty on any given
 * task, so rendering every one with an em dash buries the description under
 * several hundred pixels of nothing. Empty fields are dropped, and past four
 * the rest go behind a disclosure: the point of this panel is the task, not its
 * metadata.
 */
const VISIBLE_FIELDS = 4;

function CustomFields(props: {
  taskId: string;
  fields: TaskDetailData["customFields"];
  onChanged: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [menu, setMenu] = createSignal<{
    field: Field;
    anchor: { x: number; y: number };
  } | null>(null);

  /*
   * An empty field is still worth showing once you can fill it.
   *
   * Collapsed, only the fields that have a value are listed — a real ClickUp
   * list carries a dozen and most are blank on any given task. Expanded, the
   * blanks come too, because that is the only way to set one.
   */
  const decorated = () =>
    props.fields.map((field) => ({
      ...field,
      display: formatFieldValue(field.type, field.typeConfig, field.value),
    }));

  const filled = () => decorated().filter((field) => field.display !== "—");
  const shown = () => (expanded() ? decorated() : filled().slice(0, VISIBLE_FIELDS));
  const hidden = () => decorated().length - shown().length;

  /** Sends the value and asks the parent to refetch, since it lives in a resource. */
  const write = async (fieldId: string, value: unknown) => {
    setMenu(null);
    try {
      await api.setField(props.taskId, fieldId, value);
      props.onChanged();
    } catch (error) {
      pushToast({ tone: "error", title: "Could not set the field", detail: message(error) });
    }
  };

  return (
    <>
      <For each={shown()}>
        {(field) => (
          <Property label={field.name}>
            <FieldValue
              field={field}
              onPick={(anchor) => setMenu({ field, anchor })}
              onToggle={(next) => void write(field.id, next)}
              onText={(next) => void write(field.id, next)}
            />
          </Property>
        )}
      </For>

      <Show when={menu()}>
        {(open) => (
          <Menu
            anchor={open().anchor}
            width={240}
            placeholder={`Set ${open().field.name}…`}
            items={fieldOptions(open().field)}
            onSelect={(id) => void write(open().field.id, id === CLEAR ? null : id)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>

      <Show when={hidden() > 0 || expanded()}>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          class="flex h-6 items-center px-2 text-sm text-ink-3 hover:text-ink-2"
        >
          {expanded() ? "Show less" : `Show ${hidden()} more`}
        </button>
      </Show>
    </>
  );
}

function Property(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex items-center gap-3 px-2">
      <span class="w-[104px] shrink-0 truncate text-sm text-ink-3" title={props.label}>
        {props.label}
      </span>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

function TitleField(props: { value: string; onCommit: (value: string) => void }): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  let input!: HTMLTextAreaElement;

  return (
    <Show
      when={editing()}
      fallback={
        <h1
          class="selectable cursor-text font-semibold text-lg text-ink leading-tight tracking-[-0.02em]"
          onDblClick={() => setEditing(true)}
        >
          {props.value}
        </h1>
      }
    >
      <textarea
        ref={input}
        rows={2}
        value={props.value}
        autofocus
        onBlur={(event) => {
          setEditing(false);
          const next = event.currentTarget.value.trim();
          if (next && next !== props.value) props.onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            input.blur();
          }
          if (event.key === "Escape") {
            input.value = props.value;
            input.blur();
          }
          event.stopPropagation();
        }}
        class="w-full resize-none font-semibold text-lg text-ink leading-tight tracking-[-0.02em]"
      />
    </Show>
  );
}

/**
 * The conversation.
 *
 * Every write here answers with the whole task detail, so the panel never has
 * to reconcile a comment list by hand: it hands the response straight back to
 * the resource. The optimism that matters happens twice below this — the
 * server writes the mirror before it answers, and the outbox reverts it if
 * ClickUp says no.
 */
function Comments(props: {
  taskId: string;
  threads: CommentThread[];
  onDetail: (detail: TaskDetailData) => void;
}): JSX.Element {
  const [replyingTo, setReplyingTo] = createSignal<string | null>(null);

  /** Replies are comments. A thread count next to the word "Comments" would lie. */
  const total = () => props.threads.reduce((n, thread) => n + 1 + thread.replies.length, 0);

  const post = async (text: string, parentId?: string) => {
    const clientId = crypto.randomUUID();
    try {
      props.onDetail(await api.comment(props.taskId, { text, parentId, clientId }));
    } catch (error) {
      pushToast({ tone: "error", title: "Could not post the comment", detail: message(error) });
    }
  };

  return (
    <section class="border-line/70 border-t px-5 py-4">
      <h3 class="flex items-baseline gap-1.5 pb-3 font-medium text-xs text-ink-4 uppercase tracking-[0.04em]">
        Comments
        <Show when={total() > 0}>
          <span class="tabular-nums lowercase">{total()}</span>
        </Show>
      </h3>

      <Show
        when={props.threads.length > 0}
        fallback={<p class="text-ink-4 text-xs">No comments yet.</p>}
      >
        <ol class="space-y-4">
          <For each={props.threads}>
            {(thread) => (
              <li>
                <CommentItem
                  comment={thread}
                  taskId={props.taskId}
                  onDetail={props.onDetail}
                  onReply={() => setReplyingTo(replyingTo() === thread.id ? null : thread.id)}
                />

                <Show when={thread.replies.length > 0 || replyingTo() === thread.id}>
                  {/* One indent, ever. A rail carries the eye down the thread
                      without a staircase forming under a long conversation. */}
                  <div class="mt-3 ml-2.5 space-y-3 border-line border-l pl-3.5">
                    <For each={thread.replies}>
                      {(reply) => (
                        <CommentItem
                          comment={reply}
                          taskId={props.taskId}
                          onDetail={props.onDetail}
                        />
                      )}
                    </For>

                    <Show when={replyingTo() === thread.id}>
                      <Composer
                        placeholder="Reply…"
                        submitLabel="Reply"
                        autofocus
                        onCancel={() => setReplyingTo(null)}
                        onSubmit={(text) => {
                          setReplyingTo(null);
                          void post(text, thread.id);
                        }}
                      />
                    </Show>
                  </div>
                </Show>

                {/* Replies live behind their own endpoint, so a fresh thread is
                    a count before it is a conversation. Say so rather than
                    render an empty thread that looks complete. */}
                <Show when={thread.replyCount > thread.replies.length}>
                  <p class="mt-2 ml-6 text-xs text-ink-4">
                    Syncing {thread.replyCount - thread.replies.length} more{" "}
                    {thread.replyCount - thread.replies.length === 1 ? "reply" : "replies"}…
                  </p>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <div class="mt-4">
        <Composer
          placeholder="Leave a comment…"
          submitLabel="Comment"
          onSubmit={(text) => void post(text)}
        />
      </div>
    </section>
  );
}

/** One comment, top level or reply. The only difference is who can reply to it. */
function CommentItem(props: {
  comment: Comment;
  taskId: string;
  onDetail: (detail: TaskDetailData) => void;
  onReply?: () => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const pending = () => props.comment.id.startsWith("tmp_");
  const mine = () => props.comment.userId != null && props.comment.userId === me()?.id;

  const write = async (run: () => Promise<TaskDetailData>, what: string) => {
    try {
      props.onDetail(await run());
    } catch (error) {
      pushToast({ tone: "error", title: `Could not ${what}`, detail: message(error) });
    }
  };

  return (
    <div class="group flex gap-2.5" classList={{ "opacity-50": pending() }}>
      <Avatar
        user={{
          id: props.comment.userId ?? "",
          username: props.comment.username,
          initials: props.comment.initials,
          color: props.comment.color,
          avatar: props.comment.avatar,
        }}
        size={20}
      />

      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="font-medium text-base text-ink">{props.comment.username ?? "Someone"}</span>
          <span class="text-xs text-ink-4">
            {pending() ? "Sending…" : formatRelative(props.comment.date)}
          </span>
          <Show when={props.comment.editedAt}>
            <span class="text-xs text-ink-4" title="Edited in Rask">
              edited
            </span>
          </Show>
          <Show when={props.comment.resolved}>
            <span class="rounded bg-chip px-1.5 text-xs text-ink-3 uppercase tracking-[0.04em]">
              Resolved
            </span>
          </Show>
        </div>

        <Show
          when={editing()}
          fallback={
            <>
              {/* Sanitized in renderMarkdown. Comment bodies are other
                  people's input and never reach the DOM raw. The rich body
                  falls back to the flat text on a comment ClickUp has not
                  answered about yet. */}
              <div
                class="prose-rask selectable text-base"
                classList={{ "opacity-60": props.comment.resolved }}
                innerHTML={renderMarkdown(props.comment.markdown ?? props.comment.text)}
              />

              <Show when={!pending()}>
                <div class="-ml-1 flex items-center gap-1 pt-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Show when={props.onReply}>
                    <CommentAction label="Reply" onClick={() => props.onReply?.()} />
                  </Show>
                  <CommentAction
                    label={props.comment.resolved ? "Unresolve" : "Resolve"}
                    onClick={() =>
                      void write(
                        () =>
                          api.patchComment(props.comment.id, {
                            resolved: !props.comment.resolved,
                          }),
                        "resolve the comment",
                      )
                    }
                  />
                  <Show when={mine()}>
                    {/* An image, a file or a table cannot survive our edit: the
                        endpoint replaces the body with the text we send, and
                        the text is only its flattening. Those go to ClickUp. */}
                    <Show
                      when={props.comment.editable}
                      fallback={
                        <a
                          href={`https://app.clickup.com/t/${props.taskId}`}
                          target="_blank"
                          rel="noreferrer"
                          title="This comment has an attachment Rask cannot edit without losing it"
                          class="text-[11px] text-ink-3 hover:text-ink-2"
                        >
                          Edit in ClickUp
                        </a>
                      }
                    >
                      <CommentAction label="Edit" onClick={() => setEditing(true)} />
                    </Show>
                    <CommentAction
                      label="Delete"
                      onClick={() =>
                        void write(() => api.deleteComment(props.comment.id), "delete the comment")
                      }
                    />
                  </Show>
                </div>
              </Show>
            </>
          }
        >
          <div class="pt-1">
            <Composer
              initial={props.comment.text ?? ""}
              placeholder="Edit the comment…"
              submitLabel="Save"
              autofocus
              onCancel={() => setEditing(false)}
              onSubmit={(text) => {
                setEditing(false);
                void write(() => api.patchComment(props.comment.id, { text }), "edit the comment");
              }}
            />
          </div>
        </Show>
      </div>
    </div>
  );
}

function CommentAction(props: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="rounded-[4px] px-1 py-0.5 text-xs text-ink-4 hover:bg-hover hover:text-ink-2"
    >
      {props.label}
    </button>
  );
}

/**
 * The one text box behind writing, replying and editing.
 *
 * Keydown is stopped here, not filtered upstairs: the shell owns a single
 * global listener and `j`, `k` and `c` are all letters people type.
 */
function Composer(props: {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  autofocus?: boolean;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}): JSX.Element {
  const [text, setText] = createSignal(props.initial ?? "");
  const [mention, setMention] = createSignal<MentionQuery | null>(null);
  const [picked, setPicked] = createSignal(0);
  let box!: HTMLTextAreaElement;

  /** Members matching the `@token` under the caret, best first. */
  const candidates = () => {
    const query = mention();
    if (!query) return [];
    const term = query.term.toLowerCase();
    const pool = members().filter((user) => user.username || user.email);
    if (!term) return pool.slice(0, 6);
    return pool
      .filter((user) => `${user.username ?? ""} ${user.email ?? ""}`.toLowerCase().includes(term))
      .sort((a, b) => {
        // Someone whose name starts with what you typed is who you meant.
        const aStarts = (a.username ?? "").toLowerCase().startsWith(term) ? 0 : 1;
        const bStarts = (b.username ?? "").toLowerCase().startsWith(term) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 6);
  };

  const syncMention = () => {
    setMention(mentionQueryAt(box.value, box.selectionStart));
    setPicked(0);
  };

  const insert = (user: Assignee) => {
    const query = mention();
    if (!query) return;
    const next = applyMention(
      box.value,
      query,
      box.selectionStart,
      formatMention({ id: user.id, name: user.username ?? user.email ?? user.id }),
    );
    setText(next.text);
    setMention(null);
    // Restore the caret after Solid writes the new value back into the box.
    queueMicrotask(() => {
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    const value = text().trim();
    if (!value) return;
    setText(props.initial === undefined ? "" : value);
    props.onSubmit(value);
  };

  // Focused by hand, not by the attribute. `autofocus` is ignored when the
  // element is inserted while something else already has focus, which is
  // always the case here: the button that opened this box does. Every
  // keystroke that misses the box reaches the shell's shortcuts instead.
  onMount(() => {
    if (props.autofocus) box.focus();
  });

  return (
    <div class="relative rounded-lg border border-line bg-elevated/70 focus-within:border-line-strong">
      <Show when={mention() && candidates().length > 0}>
        {/* Anchored to the box rather than the caret. Tracking the caret in a
            textarea means mirroring its content into a hidden element to
            measure, which is a lot of machinery for a list that is readable
            either way. */}
        <div class="floating absolute bottom-full left-0 z-30 mb-1 w-[280px] overflow-hidden rounded-lg p-1">
          <For each={candidates()}>
            {(user, index) => (
              <button
                type="button"
                // The box must not lose focus, or the caret position is gone
                // before the click handler can use it.
                onMouseDown={(event) => {
                  event.preventDefault();
                  insert(user);
                }}
                onMouseEnter={() => setPicked(index())}
                class="flex h-8 w-full items-center gap-2 rounded-[5px] px-2 text-left text-base"
                classList={{
                  "row-selected text-ink": picked() === index(),
                  "text-ink-2": picked() !== index(),
                }}
              >
                <Avatar user={user} size={18} />
                <span class="flex-1 truncate">{user.username ?? user.email}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <textarea
        ref={box}
        rows={2}
        value={text()}
        onInput={(event) => {
          setText(event.currentTarget.value);
          syncMention();
        }}
        onClick={syncMention}
        onBlur={() => setMention(null)}
        onKeyDown={(event) => {
          const list = candidates();

          // While the picker is up it owns the arrows, Enter, Tab and Escape.
          // Everything else falls through to the box.
          if (mention() && list.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setPicked((i) => (i + 1) % list.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setPicked((i) => (i - 1 + list.length) % list.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              const user = list[picked()];
              if (user) insert(user);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setMention(null);
              return;
            }
          }

          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape" && props.onCancel) {
            event.preventDefault();
            props.onCancel();
          }
          // Arrow keys move the caret, so re-read where it landed.
          if (event.key.startsWith("Arrow")) queueMicrotask(syncMention);
          event.stopPropagation();
        }}
        placeholder={props.placeholder}
        class="w-full resize-none px-3 py-2 text-base"
      />
      <div class="flex items-center justify-between px-3 pb-2">
        <span class="text-xs text-ink-3">
          @ to mention · ⌘↵ to send{props.onCancel ? " · esc to cancel" : ""}
        </span>
        <button
          type="button"
          disabled={!text().trim()}
          onClick={submit}
          class="rounded-[5px] bg-accent px-2.5 py-1 font-medium text-on-accent text-sm disabled:opacity-30"
        >
          {props.submitLabel}
        </button>
      </div>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CLEAR = "__clear__";

type Field = TaskDetailData["customFields"][number] & { display: string };

/**
 * One custom field's value, editable in place where ClickUp's type allows it.
 *
 * Dropdowns and labels open the shared menu; a checkbox toggles; text and
 * number edit inline. Anything else — formula, location, attachment — stays
 * read-only, because writing a value we cannot render back is how a field ends
 * up holding something nobody meant.
 */
function FieldValue(props: {
  field: Field;
  onPick: (anchor: { x: number; y: number }) => void;
  onToggle: (next: boolean) => void;
  onText: (next: string | null) => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const type = () => props.field.type;
  const pickable = () => type() === "drop_down" || type() === "labels";
  const typable = () =>
    type() === "text" || type() === "short_text" || type() === "number" || type() === "url";

  return (
    <Show
      when={pickable() || type() === "checkbox" || typable()}
      fallback={
        <span
          class="flex h-6 items-center truncate text-base text-ink-2"
          title={props.field.display}
        >
          {props.field.display}
        </span>
      }
    >
      <Show when={type() === "checkbox"}>
        <button
          type="button"
          onClick={() => props.onToggle(props.field.display !== "Yes")}
          class="-mx-1.5 flex h-6 items-center gap-2 rounded-[5px] px-1.5 text-base text-ink-2 hover:bg-hover"
        >
          <span
            class="flex size-3.5 items-center justify-center rounded-[3px] border"
            classList={{
              "border-accent bg-accent text-white": props.field.display === "Yes",
              "border-line-strong": props.field.display !== "Yes",
            }}
          >
            <Show when={props.field.display === "Yes"}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M2 5.2 4 7.2 8 2.8"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </Show>
          </span>
          {props.field.display === "Yes" ? "Yes" : "No"}
        </button>
      </Show>

      <Show when={pickable()}>
        <button
          type="button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            props.onPick({ x: rect.left, y: rect.bottom + 6 });
          }}
          class="-mx-1.5 flex h-6 w-full items-center rounded-[5px] px-1.5 text-left"
          classList={{ "hover:bg-hover": true }}
          title={props.field.display}
        >
          <span
            class="truncate text-base"
            classList={{
              "text-ink-2": props.field.display !== "—",
              "text-ink-4": props.field.display === "—",
            }}
          >
            {props.field.display === "—" ? "Set…" : props.field.display}
          </span>
        </button>
      </Show>

      <Show when={typable()}>
        <Show
          when={editing()}
          fallback={
            <button
              type="button"
              onClick={() => setEditing(true)}
              class="-mx-1.5 flex h-6 w-full items-center rounded-[5px] px-1.5 text-left hover:bg-hover"
              title={props.field.display}
            >
              <span
                class="truncate text-base"
                classList={{
                  "text-ink-2": props.field.display !== "—",
                  "text-ink-4": props.field.display === "—",
                }}
              >
                {props.field.display === "—" ? "Set…" : props.field.display}
              </span>
            </button>
          }
        >
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            type={type() === "number" ? "number" : "text"}
            value={props.field.display === "—" ? "" : props.field.display}
            onBlur={(event) => {
              setEditing(false);
              const next = event.currentTarget.value.trim();
              if (next !== (props.field.display === "—" ? "" : props.field.display)) {
                props.onText(next === "" ? null : next);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = props.field.display === "—" ? "" : props.field.display;
                event.currentTarget.blur();
              }
              event.stopPropagation();
            }}
            class="-mx-1.5 h-6 w-full rounded-[5px] bg-elevated px-1.5 text-base text-ink"
          />
        </Show>
      </Show>
    </Show>
  );
}

/** Menu entries for a dropdown or label field, straight from its type_config. */
function fieldOptions(field: Field): MenuItem[] {
  const options =
    (field.typeConfig as { options?: Array<{ id: string; name?: string; label?: string }> } | null)
      ?.options ?? [];

  return [
    ...options.map((option) => ({
      id: option.id,
      label: option.name ?? option.label ?? option.id,
    })),
    { id: CLEAR, label: "Clear" },
  ];
}

/** Custom field values arrive raw. Only the types worth rendering get special care. */
function formatFieldValue(type: string, config: unknown, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";

  if (type === "drop_down") {
    const options = (
      config as { options?: Array<{ id: string; name: string; orderindex: number }> }
    )?.options;
    const match = options?.find((option) => option.id === value || option.orderindex === value);
    return match?.name ?? String(value);
  }

  if (type === "labels" && Array.isArray(value)) {
    const options = (config as { options?: Array<{ id: string; label: string }> })?.options;
    return value
      .map((id) => options?.find((option) => option.id === id)?.label ?? String(id))
      .join(", ");
  }

  if (type === "checkbox") return value === "true" || value === true ? "Yes" : "No";
  if (type === "date") return new Date(Number(value)).toLocaleDateString();
  if (type === "users" && Array.isArray(value)) {
    return value.map((user: { username?: string }) => user.username ?? "?").join(", ");
  }
  // location, formula, attachment and whatever ClickUp adds next. Printing raw
  // JSON at a person is worse than admitting we do not render this one.
  if (typeof value === "object") return "—";
  return String(value);
}
