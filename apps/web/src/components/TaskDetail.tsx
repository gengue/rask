import { formatMention } from "@rask/clickup-client/mentions";
import { isPlaceholder, parseInstant } from "@rask/clickup-client/vocabulary";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  lazy,
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
  withLiveTask,
} from "../lib/api.ts";
import { attachmentMarkdown, createUploader, filesFrom } from "../lib/attach.ts";
import {
  CLEAR,
  customFieldWrite,
  type FieldWrite,
  fieldInstant,
  formatFieldValue,
  isNumeric,
  labelsOn,
  peopleIn,
  typedFieldWrite,
} from "../lib/custom-fields.ts";
import {
  formatDue,
  formatRelative,
  fromDateInput,
  PRIORITY_LABELS,
  toDateInput,
} from "../lib/format.ts";
import { useLiveTask } from "../lib/live.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { applyMention, type MentionQuery, mentionQueryAt } from "../lib/mention-query.ts";
import { useExpanded } from "../lib/nav.tsx";
import { me, members } from "../lib/session.ts";
import { pushedDetail } from "../lib/sse.ts";
import { stableDetail } from "../lib/stable-detail.ts";
import { tasks } from "../lib/store.ts";
import { pushToast } from "../lib/toast.ts";
import { Attachments } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { Checklists } from "./Checklists.tsx";

/*
 * CodeMirror is loaded when someone starts editing, not before.
 *
 * It and its lezer grammars are about 1.1MB of the source that went into the
 * bundle — the largest thing in it by a distance — and none of it is needed to
 * read a task. Splitting it out is the difference between paying for the editor
 * on first paint and paying for it the first time you click into a description.
 */
const MarkdownEditor = lazy(() =>
  import("./MarkdownEditor.tsx").then((m) => ({ default: m.MarkdownEditor })),
);

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
  const [expanded, setExpanded] = useExpanded();

  /* Why an identical answer must come back as the same object: see the module. */
  const stable = stableDetail();

  const [detail, { mutate, refetch }] = createResource(
    () => props.taskId,
    async (id) => stable(await api.task(id)),
  );

  /**
   * The collection is the source of truth for anything the list also shows.
   *
   * Without this the panel would keep rendering the fetched snapshot, so
   * changing status from the list would move the row and leave the open detail
   * claiming the old value. Only for the Task half, which is what `withLiveTask`
   * is for: the resource still owns description, comments and custom fields.
   *
   * Through the mirror, not `tasks.get()`. The collection is a Map with no
   * signal in it, so reading it here subscribed the panel to nothing: this
   * re-ran only when the resource did, and every write that touches the
   * collection alone — the status menu, the row behind the panel, the palette,
   * a card dropped on the board — left the open task showing the old value
   * until a poll happened to bring back different bytes.
   */
  const live = useLiveTask(() => props.taskId);

  const task = () => {
    const fetched = detail();
    if (!fetched) return null;
    const row = live();
    return row ? withLiveTask(fetched, row) : fetched;
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

  /*
   * Files dropped on the panel, or picked from the attachments section.
   *
   * Not optimistic, unlike everything else here: a file has no URL until
   * ClickUp has it, and a placeholder attachment that cannot be opened is worse
   * than the second it takes. The server answers with the refreshed detail, so
   * the new row arrives with the response rather than on the next poll.
   */
  const uploader = createUploader({
    taskId: () => props.taskId,
    // The panel does not remount when another task is opened, so an upload
    // started against A can answer while B is on screen. Same guard, and for
    // the same reason, as the SSE push below.
    onUploaded: (result, _file, taskId) => {
      if (taskId === props.taskId) mutate(stable(result.detail));
    },
  });
  let filePicker!: HTMLInputElement;

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

  /*
   * The SSE feed writes refreshed rows into the collection. When the open task
   * is one of them, pull the fuller detail again so comments stay live.
   *
   * Guarded against re-firing on the same value. `GET /tasks/:id` starts a
   * background ClickUp refresh that pushes over SSE, the push lands in the
   * collection, this effect refetches, and that refetch starts another
   * background refresh. Comparing against the last value we acted on breaks the
   * loop; without it, a task whose refresh fails upstream spins for as long as
   * the panel is open.
   */
  let lastSeenUpdate: string | null | undefined;

  createEffect(() => {
    const row = live();
    const fetched = detail();
    if (!row || !fetched) return;
    if (row.dateUpdated === fetched.dateUpdated) return;
    if (row.dateUpdated === lastSeenUpdate) return;
    lastSeenUpdate = row.dateUpdated;
    void refetch();
  });

  // A different task means a different history.
  createEffect(() => {
    props.taskId;
    lastSeenUpdate = undefined;
  });

  // `GET /tasks/:id` refreshes from ClickUp in the background and pushes the
  // result back over SSE. This is where that push lands.
  createEffect(() => {
    const pushed = pushedDetail();
    if (pushed?.id === props.taskId) mutate(stable(pushed));
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
      class="relative flex flex-col bg-panel"
      {...uploader.handlers}
      classList={{
        /*
         * Above `split` this is a flex sibling of the list, exactly as it was.
         * Below it the same 420px becomes a right-aligned sheet over the list:
         * a row at 1280 with the panel docked got 604px, and it needs 830 to
         * keep every column and 690 to keep the title readable, so a sibling
         * panel there is not sharing the window, it is taking the list apart.
         * The scrim and the click-out live in the shell, which is also where
         * Escape has closed the task all along.
         */
        "w-[420px] max-w-full shrink-0 border-line border-l max-split:absolute max-split:inset-y-0 max-split:right-0 max-split:z-20":
          !expanded(),
        "flex-1 min-w-0": expanded(),
      }}
    >
      {/* `pointer-events-none`, or the overlay itself becomes the drop target
          and the drag leaves the panel the moment it is shown. */}
      <Show when={uploader.dragging()}>
        <div class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-panel/85 ring-2 ring-accent ring-inset">
          <span class="text-base text-ink-2">Drop to attach</span>
        </div>
      </Show>

      <input
        ref={filePicker}
        type="file"
        multiple
        class="hidden"
        onChange={(event) => {
          const files = filesFrom(event.currentTarget);
          // Cleared, or picking the same file twice in a row is a change event
          // that never fires.
          event.currentTarget.value = "";
          void uploader.upload(files);
        }}
      />

      <header class="flex h-12 shrink-0 items-center gap-2 border-line/70 border-b px-4">
        <Show when={task()?.customId}>
          <span class="font-mono text-ink-3 text-xs">{task()?.customId}</span>
        </Show>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => setExpanded(!expanded())}
          title={expanded() ? "Collapse  f" : "Expand  f"}
          aria-label={expanded() ? "Collapse task" : "Expand task"}
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
                when={expanded()}
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
              /*
               * Three explicit rows — title, description, comments — so the
               * properties rail can span all of them. Without that, the rail
               * sizes row one and leaves a hole under the title.
               *
               * Below `split` there is no room for a rail: 680 + 48 + 300 + 80
               * needs 1108px inside this panel and the window stops supplying
               * it at 1354. The second column collapses into the first and the
               * rail becomes a strip, which the source order already puts
               * above the description — the only thing that changes is the
               * template. The measure stays capped at 680px either way, so the
               * description never widens past a readable line.
               */
              "grid grid-cols-[minmax(0,680px)_300px] grid-rows-[auto_auto_1fr] justify-center content-start gap-x-12 px-10 pb-24 max-split:grid-cols-[minmax(0,680px)] max-split:grid-rows-none":
                expanded(),
            }}
          >
            <div class="px-5 pt-5 pb-4" classList={{ "col-start-1 px-0 pt-8": expanded() }}>
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
                /* Below `split` the rail lands in column one under the title.
                   Two columns of label/value rather than one, because a strip
                   that is 680px wide and one property tall wastes the width it
                   was moved here to use. */
                "col-start-2 row-start-1 row-span-3 self-start px-0 pt-8 max-split:col-start-1 max-split:row-start-auto max-split:row-span-1 max-split:grid max-split:grid-cols-2 max-split:gap-x-8 max-split:gap-y-px max-split:space-y-0 max-split:pt-0":
                  expanded(),
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
              /* Below `split` the hairline comes back: the property strip is
                 now directly above the description and the two need a seam. */
              classList={{
                "col-start-1 border-t-0 px-0 pt-0 max-split:border-t max-split:pt-6": expanded(),
              }}
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
            <div classList={{ "col-start-1": expanded() }}>
              <Attachments
                items={task().attachments}
                pending={uploader.pending()}
                onPick={() => filePicker.click()}
              />

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
              ...memberItems((id) => task()?.assignees.some((user) => user.id === id) ?? false),
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
 * A date, edited in the calendar the browser already has.
 *
 * `<input type="date">` knows the user's locale, their keyboard and how to
 * draw a month; a picker component would be a few hundred lines that know
 * less. What it does not do is open on a click anywhere but its own icon — and
 * the icon is invisible here, under a label that reads "Tomorrow" rather than
 * 09/06/2026. `showPicker()` is that missing click. Without it the field took
 * focus and the keyboard edited segments nobody could see.
 *
 * The keyboard needs the same three things spelled out, this being a
 * keyboard-first app and the input being invisible: a ring on the label, since
 * an outline on a transparent input shows nothing and `input:focus-visible`
 * turns it off anyway; Enter to open the calendar, which no `click` reaches;
 * and every key kept off the window, or Escape closes the whole panel from
 * inside a field the shortcut handler waves through as typing.
 */
function DateField(props: {
  value: number | null;
  onChange: (ms: number | null) => void;
  ariaLabel: string;
  children: JSX.Element;
}): JSX.Element {
  let input!: HTMLInputElement;

  return (
    <label class="-mx-1.5 relative flex h-6 w-full cursor-pointer items-center rounded-[5px] px-1.5 hover:bg-hover focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent">
      {props.children}
      <input
        ref={input}
        type="date"
        value={toDateInput(props.value)}
        // Optional rather than polyfilled: a browser without `showPicker` opens
        // on its own or edits by keyboard, and both beat a dialog we drew.
        onClick={() => input.showPicker?.()}
        onKeyDown={(event) => {
          if (event.key === "Enter") input.showPicker?.();
          if (event.key === "Escape") event.currentTarget.blur();
          event.stopPropagation();
        }}
        // The value it already holds is where the hours come from, so moving a
        // date does not quietly reset the time behind it.
        onChange={(event) => props.onChange(fromDateInput(event.currentTarget.value, props.value))}
        class="absolute inset-0 cursor-pointer opacity-0"
        aria-label={props.ariaLabel}
      />
    </label>
  );
}

/** The task's own due date: the same calendar, over an ISO instant. */
function DueField(props: {
  value: string | null;
  onChange: (iso: string | null) => void;
}): JSX.Element {
  const label = () => formatDue(props.value);

  return (
    <DateField
      value={parseInstant(props.value)}
      ariaLabel="Due date"
      onChange={(next) => props.onChange(next == null ? null : new Date(next).toISOString())}
    >
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
    </DateField>
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
  const [showAll, setShowAll] = createSignal(false);
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
  const shown = () => (showAll() ? decorated() : filled().slice(0, VISIBLE_FIELDS));
  const hidden = () => decorated().length - shown().length;

  /** Sends the value and asks the parent to refetch, since it lives in a resource. */
  const write = async (fieldId: string, next: FieldWrite) => {
    setMenu(null);
    try {
      await api.setField(props.taskId, fieldId, next);
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
              onValue={(next) => void write(field.id, next)}
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
            onSelect={(id) =>
              void write(open().field.id, customFieldWrite(open().field, id, members()))
            }
            onClose={() => setMenu(null)}
          />
        )}
      </Show>

      <Show when={hidden() > 0 || showAll()}>
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          class="flex h-6 items-center px-2 text-sm text-ink-3 hover:text-ink-2"
        >
          {showAll() ? "Show less" : `Show ${hidden()} more`}
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
                        taskId={props.taskId}
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
          taskId={props.taskId}
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
  const pending = () => isPlaceholder(props.comment.id);
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
              taskId={props.taskId}
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
  /** Where a dropped file goes. ClickUp has no comment-attachment endpoint. */
  taskId: string;
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
  let filePicker!: HTMLInputElement;

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
    setMention(null);
    place(next.text, next.caret);
  };

  /** Writes the box and restores the caret once Solid has written the value back. */
  const place = (value: string, caret: number) => {
    setText(value);
    queueMicrotask(() => {
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  };

  /** Puts a block on its own line at the caret, and leaves the caret after it. */
  const insertBlock = (snippet: string) => {
    const before = box.value.slice(0, box.selectionStart);
    const after = box.value.slice(box.selectionEnd);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    place(`${before}${lead}${snippet}\n${after}`, before.length + lead.length + snippet.length + 1);
  };

  /*
   * A file dropped on a comment box.
   *
   * It goes to the task, because that is the only place ClickUp will take one:
   * `POST /task/{id}/comment` accepts `comment_text` and nothing else. So the
   * comment gets a markdown link to a file the task now holds — which is where
   * ClickUp's own client puts a comment's attachments too.
   */
  const uploader = createUploader({
    taskId: () => props.taskId,
    onUploaded: (result, file) => insertBlock(attachmentMarkdown(file, result.attachment)),
  });

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
    <div
      class="relative rounded-lg border bg-elevated/70 focus-within:border-line-strong"
      classList={{ "border-accent": uploader.dragging(), "border-line": !uploader.dragging() }}
    >
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
        /* On the box rather than the wrapper: this is the thing being dropped
           on, and it is already interactive. */
        onPaste={(event) => {
          const files = filesFrom(event.clipboardData);
          if (files.length === 0) return;
          // Or the browser pastes the file's name in as text beside the link.
          event.preventDefault();
          void uploader.upload(files);
        }}
        {...uploader.handlers}
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
      <input
        ref={filePicker}
        type="file"
        multiple
        class="hidden"
        onChange={(event) => {
          const files = filesFrom(event.currentTarget);
          event.currentTarget.value = "";
          void uploader.upload(files);
        }}
      />

      <div class="flex items-center justify-between gap-2 px-3 pb-2">
        <span class="min-w-0 truncate text-xs text-ink-3">
          <Show
            when={uploader.pending()[0]}
            fallback={<>@ to mention · ⌘↵ to send{props.onCancel ? " · esc to cancel" : ""}</>}
          >
            {(name) => <>Uploading {name()}…</>}
          </Show>
        </span>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => filePicker.click()}
            title="Attach a file"
            class="rounded-[5px] px-2 py-1 font-medium text-ink-3 text-sm hover:bg-hover hover:text-ink"
          >
            Attach
          </button>
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
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Field = TaskDetailData["customFields"][number] & { display: string };

/**
 * One custom field's value, editable in place where ClickUp's type allows it.
 *
 * Dropdowns, labels and people open the shared menu; a checkbox toggles; a
 * date opens the same calendar as the due date; text, number and the
 * string-shaped types beside them edit inline. Anything else — formula,
 * location, attachment, the progress fields — stays read-only, because writing
 * a value we cannot render back is how a field ends up holding something
 * nobody meant.
 */
function FieldValue(props: {
  field: Field;
  onPick: (anchor: { x: number; y: number }) => void;
  onValue: (write: FieldWrite) => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const type = () => props.field.type;
  const pickable = () => type() === "drop_down" || type() === "labels" || type() === "users";
  const typable = () =>
    isNumeric(type()) ||
    type() === "text" ||
    type() === "short_text" ||
    type() === "url" ||
    type() === "email" ||
    type() === "phone";

  /** What the input starts with, and what a blur compares against. */
  const text = () => (props.field.display === "—" ? "" : props.field.display);

  /** The value, or an invitation to set one. The same line under all three editors. */
  const label = () => (
    <span
      class="truncate text-base"
      classList={{
        "text-ink-2": props.field.display !== "—",
        "text-ink-4": props.field.display === "—",
      }}
    >
      {props.field.display === "—" ? "Set…" : props.field.display}
    </span>
  );

  return (
    <Show
      when={pickable() || type() === "checkbox" || type() === "date" || typable()}
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
          onClick={() => props.onValue({ value: props.field.display !== "Yes" })}
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
          class="-mx-1.5 flex h-6 w-full items-center rounded-[5px] px-1.5 text-left hover:bg-hover"
          title={props.field.display}
        >
          {label()}
        </button>
      </Show>

      <Show when={type() === "date"}>
        <DateField
          value={fieldInstant(props.field.value)}
          ariaLabel={props.field.name}
          onChange={(ms) => props.onValue({ value: ms })}
        >
          {label()}
        </DateField>
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
              {label()}
            </button>
          }
        >
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            type={isNumeric(type()) ? "number" : "text"}
            value={text()}
            onBlur={(event) => {
              setEditing(false);
              /*
               * A number input hands back the empty string for anything it
               * cannot parse, so "12." and "" are the same event here. Leaving
               * the field alone is the only safe reading of the first, and
               * `badInput` is what tells them apart: without it, a typo in a
               * Money field clears it.
               */
              if (event.currentTarget.validity.badInput) return;
              const next = event.currentTarget.value.trim();
              if (next === text()) return;
              props.onValue(typedFieldWrite(type(), next));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = text();
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

/**
 * The workspace directory as menu entries, ticked for whoever is already on.
 *
 * The assignee menu and a People field ask the same question of the same list,
 * and both toggle rather than replace — a checkmark is the only thing that says
 * so before the click.
 */
function memberItems(isOn: (id: string) => boolean): MenuItem[] {
  return members().map((user) => ({
    id: user.id,
    label: user.username ?? user.id,
    hint: isOn(user.id) ? "✓" : "",
    icon: <Avatar user={user} size={16} />,
  }));
}

/**
 * Menu entries for the three field types that pick rather than type: a dropdown
 * and a Label field from their own `type_config`, a People field from the
 * workspace directory, since it has no options of its own.
 */
function fieldOptions(field: Field): MenuItem[] {
  if (field.type === "users") {
    const current = new Set(peopleIn(field));
    return [{ id: CLEAR, label: "Clear all" }, ...memberItems((id) => current.has(id))];
  }

  const options =
    (field.typeConfig as { options?: Array<{ id: string; name?: string; label?: string }> } | null)
      ?.options ?? [];
  // A Label field holds several at once and this menu toggles one of them, so
  // it needs the same tick the People one has. A dropdown holds one, and the
  // value on the row beside it already says which.
  const applied = new Set(field.type === "labels" ? labelsOn(field) : []);

  return [
    ...options.map((option) => ({
      id: option.id,
      label: option.name ?? option.label ?? option.id,
      hint: applied.has(option.id) ? "✓" : "",
    })),
    { id: CLEAR, label: field.type === "labels" ? "Clear all" : "Clear" },
  ];
}
