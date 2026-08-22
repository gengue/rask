import { type JSX, Show } from "solid-js";
import type { Assignee } from "../lib/api.ts";
import { initialsOf } from "../lib/format.ts";

export function Avatar(props: {
  user: Assignee | null;
  size?: number;
  class?: string;
}): JSX.Element {
  const size = () => props.size ?? 18;

  return (
    <Show
      when={props.user}
      fallback={
        <div
          class="rounded-full border border-dashed border-line-strong"
          style={{ width: `${size()}px`, height: `${size()}px` }}
          title="Unassigned"
        />
      }
    >
      {(user) => (
        <Show
          when={user().avatar}
          /*
           * Initials on a disc, in the colour ClickUp gave the member.
           *
           * White on that colour is a fixed pairing that no theme can change,
           * because the background is a workspace value rather than a Rask
           * surface. The fallback, for a member with no colour at all, is a
           * theme token and so has to take a theme ink with it.
           */
          fallback={
            <div
              class="flex shrink-0 items-center justify-center rounded-full font-medium"
              classList={{ "text-white": Boolean(user().color), "text-ink": !user().color }}
              style={{
                width: `${size()}px`,
                height: `${size()}px`,
                "font-size": `${Math.round(size() * 0.42)}px`,
                background: user().color ?? "var(--color-line-strong)",
              }}
              title={user().username ?? undefined}
            >
              {initialsOf(user().username, user().initials)}
            </div>
          }
        >
          <img
            src={user().avatar ?? ""}
            alt={user().username ?? ""}
            title={user().username ?? undefined}
            class="shrink-0 rounded-full object-cover"
            style={{ width: `${size()}px`, height: `${size()}px` }}
          />
        </Show>
      )}
    </Show>
  );
}

/** Overlapping stack, capped so a task with nine assignees does not eat the row. */
export function AvatarStack(props: { users: Assignee[]; max?: number }): JSX.Element {
  const max = () => props.max ?? 3;
  const shown = () => props.users.slice(0, max());
  const extra = () => props.users.length - shown().length;

  return (
    <div class="flex items-center">
      <Show when={props.users.length > 0} fallback={<Avatar user={null} />}>
        {shown().map((user, index) => (
          <div
            class="rounded-full ring-2 ring-panel"
            style={{ "margin-left": index === 0 ? "0" : "-5px", "z-index": String(10 - index) }}
          >
            <Avatar user={user} />
          </div>
        ))}
        <Show when={extra() > 0}>
          <div class="ml-1 text-ink-3 text-xs tabular-nums">+{extra()}</div>
        </Show>
      </Show>
    </div>
  );
}
