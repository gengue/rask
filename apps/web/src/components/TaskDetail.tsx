import { createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../lib/api.ts";
import { formatDue, formatRelative, PRIORITY_LABELS } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { tasks } from "../lib/store.ts";
import { Avatar } from "./Avatar.tsx";
import { PriorityIcon, StatusIcon } from "./StatusIcon.tsx";

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

  // The SSE feed writes refreshed rows into the collection. When the open task
  // is one of them, pull the fuller detail again so comments stay live.
  createEffect(() => {
    const row = tasks.get(props.taskId);
    if (row && detail() && row.dateUpdated !== detail()?.dateUpdated) void refetch();
  });

  return (
    <aside class="flex w-[420px] shrink-0 flex-col border-line border-l bg-panel">
      <header class="flex h-12 shrink-0 items-center gap-2 border-line/70 border-b px-4">
        <Show when={task()?.customId}>
          <span class="font-mono text-ink-3 text-xs">{task()?.customId}</span>
        </Show>
        <div class="flex-1" />
        <Show when={task()?.url}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noreferrer"
              title="Open in ClickUp"
              class="flex size-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-white/[0.06] hover:text-ink"
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
          class="flex size-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-white/[0.06] hover:text-ink"
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
        {(task) => (
          <div class="flex-1 overflow-y-auto">
            <div class="px-5 pt-5 pb-4">
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

            <div class="space-y-px px-3 pb-4">
              <Property label="Status">
                <button
                  type="button"
                  onClick={props.onStatusClick}
                  class="-mx-1.5 flex h-6 items-center gap-2 rounded-[5px] px-1.5 hover:bg-white/[0.06]"
                >
                  <StatusIcon type={task().statusType} color={task().statusColor} />
                  <span class="text-[13px] text-ink capitalize">{task().status ?? "None"}</span>
                </button>
              </Property>

              <Property label="Priority">
                <div class="flex h-6 items-center gap-2">
                  <PriorityIcon priority={task().priority} />
                  <span class="text-[13px] text-ink-2">
                    {task().priority ? PRIORITY_LABELS[task().priority ?? 0] : "None"}
                  </span>
                </div>
              </Property>

              <Property label="Assignees">
                <div class="flex h-6 items-center gap-2">
                  <Show
                    when={task().assignees.length > 0}
                    fallback={<span class="text-[13px] text-ink-4">Unassigned</span>}
                  >
                    <For each={task().assignees}>
                      {(user) => (
                        <span class="flex items-center gap-1.5">
                          <Avatar user={user} size={17} />
                          <span class="text-[13px] text-ink-2">{user.username}</span>
                        </span>
                      )}
                    </For>
                  </Show>
                </div>
              </Property>

              <Property label="Due">
                <span
                  class="flex h-6 items-center text-[13px]"
                  classList={{
                    "text-urgent": formatDue(task().dueDate)?.tone === "overdue",
                    "text-ink-2": formatDue(task().dueDate)?.tone !== "overdue",
                  }}
                >
                  {formatDue(task().dueDate)?.text ?? "No due date"}
                </span>
              </Property>

              <Property label="List">
                <span class="flex h-6 items-center truncate text-[13px] text-ink-2">
                  {task().listName ?? "—"}
                </span>
              </Property>

              <For each={task().customFields}>
                {(field) => (
                  <Property label={field.name}>
                    <span class="flex h-6 items-center truncate text-[13px] text-ink-2">
                      {formatFieldValue(field.type, field.typeConfig, field.value)}
                    </span>
                  </Property>
                )}
              </For>
            </div>

            <Show when={task().description}>
              <section class="border-line/70 border-t px-5 py-4">
                <div
                  class="prose-rask selectable text-[13px]"
                  // Sanitized in renderMarkdown. ClickUp descriptions are other
                  // people's input and never reach the DOM unfiltered.
                  innerHTML={renderMarkdown(task().description)}
                />
              </section>
            </Show>

            <section class="border-line/70 border-t px-5 py-4">
              <h3 class="pb-3 font-medium text-[11px] text-ink-4 uppercase tracking-[0.04em]">
                Comments
              </h3>

              <Show
                when={task().comments.length > 0}
                fallback={<p class="text-ink-4 text-xs">No comments yet.</p>}
              >
                <ol class="space-y-3.5">
                  <For each={task().comments}>
                    {(comment) => (
                      <li class="flex gap-2.5">
                        <Avatar
                          user={{
                            id: comment.userId ?? "",
                            username: comment.username,
                            initials: comment.initials,
                            color: comment.color,
                            avatar: comment.avatar,
                          }}
                          size={20}
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-baseline gap-2">
                            <span class="font-medium text-[13px] text-ink">
                              {comment.username ?? "Someone"}
                            </span>
                            <span class="text-[11px] text-ink-4">
                              {formatRelative(comment.date)}
                            </span>
                          </div>
                          <div
                            class="prose-rask selectable text-[13px]"
                            innerHTML={renderMarkdown(comment.text)}
                          />
                        </div>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>

              <CommentBox
                taskId={props.taskId}
                onSent={(text) => {
                  // Show it immediately; the worker's next sync replaces this
                  // with ClickUp's real comment, id and all.
                  mutate((current) =>
                    current
                      ? {
                          ...current,
                          comments: [
                            ...current.comments,
                            {
                              id: `tmp_${Date.now()}`,
                              text,
                              date: new Date().toISOString(),
                              resolved: false,
                              replyCount: 0,
                              userId: null,
                              username: "You",
                              initials: null,
                              color: null,
                              avatar: null,
                            },
                          ],
                        }
                      : current,
                  );
                }}
              />
            </section>
          </div>
        )}
      </Show>
    </aside>
  );
}

function Property(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex items-center gap-3 px-2">
      <span class="w-[76px] shrink-0 text-[12px] text-ink-4">{props.label}</span>
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
          class="selectable cursor-text font-semibold text-[19px] text-ink leading-tight tracking-[-0.02em]"
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
        class="w-full resize-none font-semibold text-[19px] text-ink leading-tight tracking-[-0.02em]"
      />
    </Show>
  );
}

function CommentBox(props: { taskId: string; onSent: (text: string) => void }): JSX.Element {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const send = async () => {
    const value = text().trim();
    if (!value || sending()) return;
    setSending(true);
    setText("");
    props.onSent(value);
    try {
      await api.comment(props.taskId, value);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="mt-4 rounded-lg border border-line bg-elevated/70 focus-within:border-line-strong">
      <textarea
        rows={2}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
          event.stopPropagation();
        }}
        placeholder="Leave a comment…"
        class="w-full resize-none px-3 py-2 text-[13px]"
      />
      <div class="flex items-center justify-between px-3 pb-2">
        <span class="text-[11px] text-ink-4">⌘↵ to send</span>
        <button
          type="button"
          disabled={!text().trim()}
          onClick={() => void send()}
          class="rounded-[5px] bg-accent px-2.5 py-1 font-medium text-[12px] text-white disabled:opacity-30"
        >
          Comment
        </button>
      </div>
    </div>
  );
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
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
