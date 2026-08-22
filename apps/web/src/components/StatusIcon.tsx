import { type JSX, Show } from "solid-js";

/**
 * The status glyph, and the one piece of custom drawing in the app.
 *
 * ClickUp gives every status a colour and a coarse type. The type picks the
 * shape (open is hollow, custom is a half-filled pie, done is a filled check)
 * and the colour comes straight from the workspace, so a team that made
 * "Blocked" red sees red here without Rask knowing what "Blocked" means.
 */
export function StatusIcon(props: {
  type: string | null;
  color: string | null;
  size?: number;
  class?: string;
}): JSX.Element {
  const size = () => props.size ?? 14;
  const color = () => props.color ?? "#6b6f76";
  const done = () => props.type === "done" || props.type === "closed";
  const open = () => props.type === "open" || props.type === null;

  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 14 14"
      fill="none"
      class={props.class}
      aria-hidden="true"
    >
      <Show
        when={done()}
        fallback={
          <>
            <circle
              cx="7"
              cy="7"
              r="5.5"
              stroke={color()}
              stroke-width="1.5"
              stroke-dasharray={open() ? "1.6 1.9" : undefined}
              stroke-linecap="round"
            />
            {/* Custom statuses are "in flight": a pie wedge reads as progress. */}
            <Show when={!open()}>
              <path d="M7 7 L7 2.9 A4.1 4.1 0 0 1 11.1 7 Z" fill={color()} />
            </Show>
          </>
        }
      >
        <circle cx="7" cy="7" r="6" fill={color()} />
        <path
          d="M4.4 7.2 L6.2 9 L9.7 5.2"
          stroke="#0b0c0d"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </Show>
    </svg>
  );
}

/**
 * Rising bars for a set priority, three faint dots for none.
 *
 * The dots matter: on a list where most tasks have no priority, drawing empty
 * bars for every one of them puts a grid of grey noise down the left edge.
 */
export function PriorityIcon(props: { priority: number | null; class?: string }): JSX.Element {
  const filled = () => (props.priority === null ? 0 : 5 - props.priority);
  const tone = () =>
    props.priority === 1
      ? "var(--color-urgent)"
      : props.priority === 2
        ? "var(--color-high)"
        : "var(--color-ink-2)";

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" class={props.class} aria-hidden="true">
      <Show
        when={props.priority !== null}
        fallback={[3, 7, 11].map((x) => (
          <circle cx={x} cy="7" r="1" fill="var(--color-ink-4)" opacity="0.5" />
        ))}
      >
        {[0, 1, 2].map((i) => (
          <rect
            x={2 + i * 4}
            y={9.5 - i * 3}
            width="2.6"
            height={2 + i * 3}
            rx="1.1"
            fill={i < filled() ? tone() : "var(--color-line-strong)"}
          />
        ))}
      </Show>
    </svg>
  );
}
