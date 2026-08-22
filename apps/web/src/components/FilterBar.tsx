import { createSignal, For, type JSX, Show } from "solid-js";
import { setUi, ui } from "../lib/ui.ts";
import { facets } from "../lib/view.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { StatusIcon } from "./StatusIcon.tsx";

type Facet = "status" | "assignee" | "tag";

/**
 * Status, assignee and tag filters.
 *
 * A facet with nothing to choose from is hidden rather than shown empty: on a
 * list where nobody uses tags, a permanently disabled Tag button is furniture.
 */
export function FilterBar(): JSX.Element {
  const [open, setOpen] = createSignal<{ facet: Facet; anchor: { x: number; y: number } } | null>(
    null,
  );

  const options = (facet: Facet): MenuItem[] => {
    const data = facets();
    if (facet === "status") {
      return data.statuses.map((status) => ({
        id: status.value,
        label: status.value,
        icon: <StatusIcon type={status.type} color={status.color} size={13} />,
      }));
    }
    if (facet === "assignee") {
      return data.assignees.map((user) => ({ id: user.value, label: user.label }));
    }
    return data.tags.map((tag) => ({ id: tag.value, label: tag.value }));
  };

  const label = (facet: Facet): string | null => {
    const value = ui.filters[facet];
    if (!value) return null;
    if (facet === "assignee") {
      return facets().assignees.find((user) => user.value === value)?.label ?? value;
    }
    return value;
  };

  return (
    <>
      <For each={["status", "assignee", "tag"] as Facet[]}>
        {(facet) => (
          <Show when={options(facet).length > 1 || ui.filters[facet]}>
            <FacetButton
              facet={facet}
              value={label(facet)}
              onOpen={(anchor) => setOpen({ facet, anchor })}
              onClear={() => setUi("filters", facet, null)}
            />
          </Show>
        )}
      </For>

      <Show when={open()}>
        {(current) => (
          <Menu
            items={options(current().facet)}
            anchor={current().anchor}
            placeholder={`Filter by ${current().facet}…`}
            onSelect={(id) => {
              setUi("filters", current().facet, id);
              setOpen(null);
            }}
            onClose={() => setOpen(null)}
          />
        )}
      </Show>
    </>
  );
}

function FacetButton(props: {
  facet: Facet;
  value: string | null;
  onOpen: (anchor: { x: number; y: number }) => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <div
      class="flex h-[22px] items-center rounded-[5px] transition-colors"
      classList={{
        "bg-accent-soft text-ink": Boolean(props.value),
        "text-ink-4 hover:bg-white/[0.04] hover:text-ink-2": !props.value,
      }}
    >
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpen({ x: rect.left, y: rect.bottom + 6 });
        }}
        class="flex h-full items-center gap-1 truncate px-1.5 text-[11.5px] capitalize"
      >
        {props.value ?? props.facet}
        <Show when={!props.value}>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="m4 6.5 4 4 4-4"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </Show>
      </button>

      <Show when={props.value}>
        <button
          type="button"
          aria-label={`Clear ${props.facet} filter`}
          onClick={props.onClear}
          class="flex h-full w-4 items-center justify-center text-ink-3 hover:text-ink"
        >
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="m4 4 8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </Show>
    </div>
  );
}
