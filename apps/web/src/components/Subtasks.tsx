import { createSignal, For, type JSX, Show } from "solid-js";
import { api, type TaskDetail, type TaskRef } from "../lib/api.ts";
import { useNavigate } from "../lib/nav.tsx";
import { pushToast } from "../lib/toast.ts";
import { AvatarStack } from "./Avatar.tsx";
import { InlineInput } from "./Checklists.tsx";
import { StatusIcon } from "./StatusIcon.tsx";

/**
 * Subtasks, on both sides of the relationship.
 *
 * The mirror has carried `parent_id` since the beginning and the list drew a
 * small `↳` from it, which told you a row was somebody's subtask without ever
 * saying whose. This is the other half: a parent lists what hangs off it, and a
 * subtask names what it hangs off.
 *
 * Subtasks stay their own rows in list views rather than folding under a
 * parent. In the Ventura workspace's Bugs list 89 of 1,200 tasks are subtasks
 * and 59 of the 70 parents have exactly one, so a tree would be mostly
 * disclosure triangles hiding a single row. More decisively, views are grouped
 * by status, due date or assignee and a parent's children rarely share its
 * group — and in My Tasks, which spans lists, the parent is often not loaded at
 * all. Folding would make a task assigned to you disappear because a task
 * assigned to somebody else was missing.
 */

/** Navigates to a task, in its own list, with the detail panel open. */
function useOpenTask(): (task: TaskRef) => void {
  const navigate = useNavigate();
  return (task) => {
    void navigate({
      to: "/list/$listId",
      params: { listId: task.listId },
      search: { task: task.id },
    });
  };
}

/**
 * "Subtask of …", above the title.
 *
 * A subtask read on its own is the one place in Rask where the task on screen
 * is not the whole story, so this sits where a breadcrumb would rather than in
 * a section further down the panel.
 */
export function ParentLink(props: { parent: TaskRef | null }): JSX.Element {
  const open = useOpenTask();

  return (
    <Show when={props.parent}>
      {(parent) => (
        <button
          type="button"
          onClick={() => open(parent())}
          class="-mx-1.5 mb-1.5 flex h-6 max-w-full items-center gap-1.5 rounded-[5px] px-1.5 text-ink-3 hover:bg-hover hover:text-ink-2"
        >
          <span aria-hidden="true" class="text-xs">
            &#8618;
          </span>
          <span class="shrink-0 text-xs">Subtask of</span>
          <StatusIcon type={parent().statusType} color={parent().statusColor} size={12} />
          <span class="truncate text-base">{parent().name}</span>
        </button>
      )}
    </Show>
  );
}

export function Subtasks(props: {
  task: TaskDetail;
  /** Applies a local edit while the request is in flight, and to undo it. */
  onOptimistic: (apply: (current: TaskDetail) => TaskDetail) => TaskDetail | null;
  /** Re-reads the parent once ClickUp has been told. */
  onRefresh: () => void;
}): JSX.Element {
  const open = useOpenTask();
  const [adding, setAdding] = createSignal(false);

  const empty = () => props.task.subtasks.length === 0;
  const done = () =>
    props.task.subtasks.filter((t) => t.statusType === "done" || t.statusType === "closed").length;

  /**
   * Creates a subtask in the parent's own list.
   *
   * ClickUp requires the parent to live in the List named in the path, so this
   * is the parent's `listId` rather than whichever list the user is looking at.
   * `POST /api/tasks` answers with the new subtask's detail, which is not what
   * this panel is showing — so the parent is re-read instead.
   */
  const create = async (name: string) => {
    const before = props.onOptimistic((current) => ({
      ...current,
      subtasks: [...current.subtasks, draft(name, current)],
    }));

    try {
      await api.createTask({
        listId: props.task.listId,
        name,
        parentId: props.task.id,
        assignees: [],
        clientId: crypto.randomUUID(),
      });
      props.onRefresh();
    } catch (error) {
      if (before) props.onOptimistic(() => before);
      pushToast({
        tone: "error",
        title: "Could not create the subtask",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    /* Empty, this is one line rather than a section. See the same note in
       Checklists: a task with neither should not pay for both. */
    <section class="px-5" classList={{ "border-line/70 border-t py-4": !empty(), "pt-2": empty() }}>
      <Show when={!empty()}>
        <h3 class="flex items-baseline gap-1.5 pb-2 font-medium text-xs text-ink-4 uppercase tracking-[0.04em]">
          Subtasks
          <span class="tabular-nums lowercase">
            {done()}/{props.task.subtasks.length}
          </span>
        </h3>
      </Show>

      <ul>
        <For each={props.task.subtasks}>
          {(subtask) => {
            const pending = () => subtask.id.startsWith("tmp_");
            return (
              <li>
                <button
                  type="button"
                  disabled={pending()}
                  onClick={() => open(subtask)}
                  class="-mx-1.5 flex h-8 w-full items-center gap-2.5 rounded-[5px] px-1.5 text-left hover:bg-hover"
                  classList={{ "opacity-55": pending() }}
                >
                  <StatusIcon type={subtask.statusType} color={subtask.statusColor} />
                  <Show when={subtask.customId}>
                    <span class="shrink-0 font-mono text-ink-3 text-xs tabular-nums">
                      {subtask.customId}
                    </span>
                  </Show>
                  <span
                    class="flex-1 truncate text-base"
                    classList={{
                      "text-ink-4 line-through":
                        subtask.statusType === "done" || subtask.statusType === "closed",
                      "text-ink": subtask.statusType !== "done" && subtask.statusType !== "closed",
                    }}
                  >
                    {subtask.name}
                  </span>
                  <span class="shrink-0">
                    <AvatarStack users={subtask.assignees} max={2} />
                  </span>
                </button>
              </li>
            );
          }}
        </For>
      </ul>

      <div classList={{ "pt-1": !empty() }}>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              onClick={() => setAdding(true)}
              class="-mx-1 rounded-[5px] px-1 py-0.5 text-ink-4 text-xs hover:bg-hover hover:text-ink-2"
            >
              + Add subtask
            </button>
          }
        >
          <InlineInput
            placeholder="Subtask name…"
            submitLabel="Add"
            keepOpen
            onCancel={() => setAdding(false)}
            onSubmit={(name) => void create(name)}
          />
        </Show>
      </div>
    </section>
  );
}

/**
 * The row shown while the create is in flight.
 *
 * It borrows the parent's status so the glyph is not a hole for the second it
 * takes ClickUp to answer — a new task lands in the list's default status,
 * which is usually the parent's, and the refresh corrects it either way.
 */
function draft(name: string, parent: TaskDetail): TaskRef {
  return {
    id: `tmp_${crypto.randomUUID()}`,
    customId: null,
    name,
    status: parent.status,
    statusColor: parent.statusColor,
    statusType: parent.statusType,
    listId: parent.listId,
    assignees: [],
  };
}
