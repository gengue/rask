import { batch, createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import {
  applyChoice,
  choicesFor,
  describeClause,
  fieldsFor,
  isChosen,
  type Lookup,
  type OptionSources,
} from "../lib/filter-menu.ts";
import {
  type Clause,
  CUSTOM_FIELD_PREFIX,
  findClause,
  isCustomField,
  negate,
  removeClause,
  setClause,
} from "../lib/filters.ts";
import { me } from "../lib/session.ts";
import { setUi, ui } from "../lib/ui.ts";
import {
  filterFields,
  filterOptions,
  filterRequest,
  loadFilterFields,
  mineOnly,
  toggleMine,
  viewIsMine,
  viewListId,
} from "../lib/view.ts";
import { Avatar } from "./Avatar.tsx";
import { FilterMenu } from "./FilterMenu.tsx";

/**
 * The filter, as a row of chips plus one way to add another.
 *
 * This used to be three buttons holding one value each — status, assignee, tag
 * — so "assigned to either of us" and "not tagged template" were both
 * unsayable. A chip is a clause now: a field, an operator and a set of values,
 * in ClickUp's own vocabulary, and the row of them is the filter.
 *
 * Nothing here needs a mouse. `F` opens the builder, Enter toggles a value,
 * Tab negates the clause, Backspace goes back a step, Escape clears. The chips
 * are clickable because they are on screen anyway, not because they are the way
 * in.
 */
export function FilterBar(): JSX.Element {
  const [open, setOpen] = createSignal<{
    field: string | null;
    anchor: { x: number; y: number };
  } | null>(null);

  const sources = (): OptionSources => {
    const data = filterOptions();
    return {
      statuses: data.statuses,
      assignees: data.assignees,
      tags: data.tags,
      lists: data.lists,
      customFields: filterFields().map((field) => ({
        id: field.id,
        name: field.name.trim(),
        options: field.options,
      })),
    };
  };

  const fields = () =>
    fieldsFor({
      // Only worth offering where rows can come from more than one list.
      crossList: viewListId() === null,
      customFields: filterFields().map((field) => ({ id: field.id, name: field.name.trim() })),
    });

  /**
   * Ids are not words. This turns one into the thing it names.
   *
   * `value` is null when the caller wants the field's own name, which only a
   * Custom Field needs — every other field's name is a constant.
   */
  const lookup: Lookup = (field, value) => {
    const custom = isCustomField(field)
      ? filterFields().find((entry) => entry.id === field.slice(CUSTOM_FIELD_PREFIX.length))
      : undefined;

    if (value === null) return custom?.name.trim() ?? "Field";
    if (custom) return custom.options.find((option) => option.value === value)?.label ?? value;
    if (field === "assignee") {
      return filterOptions().assignees.find((option) => option.value === value)?.label ?? value;
    }
    if (field === "list") {
      return filterOptions().lists.find((option) => option.value === value)?.label ?? value;
    }
    return value;
  };

  /** The field being edited, or null while one is still being chosen. */
  const openField = () => open()?.field ?? null;
  const anchorOf = () => open()?.anchor ?? { x: 0, y: 0 };

  const current = () => {
    const field = openField();
    return field ? findClause(ui.filters, field) : undefined;
  };

  const partial = () => {
    const field = openField();
    const flags = filterOptions().partial;
    if (field === "status") return flags.status;
    if (field === "tag") return flags.tag;
    if (field === "assignee") return flags.assignee;
    return false;
  };

  /*
   * Both writes in one batch, or the popover opens and shuts in the same tick.
   *
   * `open` and `ui.menu` say the same thing to two different audiences — this
   * component and the shell's keyboard layer — and the effect below keeps them
   * in step. Written one after the other outside a batch, Solid flushes that
   * effect between them: it sees an open popover and a `ui.menu` that has not
   * caught up yet, and closes what was just opened. Opening from `F` hid it,
   * because a write inside an effect is already batched.
   */
  const openAt = (field: string | null, anchor: { x: number; y: number }) => {
    loadFilterFields();
    batch(() => {
      setOpen({ field, anchor });
      setUi("menu", "filter");
    });
  };

  const close = () =>
    batch(() => {
      setOpen(null);
      setUi("menu", null);
    });

  // The shell closes every overlay at once — Escape, ⌘K, opening a task — and
  // says so by clearing `ui.menu`. This popover has to hear that, or it stays
  // on screen with nothing left that thinks it is open.
  createEffect(() => {
    if (ui.menu !== "filter" && open()) setOpen(null);
  });

  // `F` from the shell. The button is the anchor, so the popover lands where a
  // click would have put it and the keyboard and the mouse agree.
  let addButton: HTMLButtonElement | undefined;
  createEffect(
    on(filterRequest, (count) => {
      if (count === 0) return;
      const rect = addButton?.getBoundingClientRect();
      openAt(null, { x: rect?.left ?? 200, y: (rect?.bottom ?? 40) + 6 });
    }),
  );

  /**
   * Whose face the quick filter wears, or null when there is no quick filter.
   *
   * Hidden on My Tasks, where the server already answered `assignee=me`, and
   * until the session lands: `Avatar` draws a dashed "Unassigned" disc for a
   * null user, and that is not what an unloaded "me" means.
   */
  const quickFilter = () => (viewIsMine() ? null : me());

  /*
   * The assignee chip while the toggle owns that clause would be the same
   * filter twice, in two controls that can be cleared independently. So the
   * chip stands down — but only where the toggle is actually on screen.
   *
   * Read off `quickFilter()` rather than restating its condition, because the
   * two spellings drifted once already: on My Tasks the toggle was hidden and
   * the chip suppressed anyway, which left `assignee ANY [me]` live in the
   * filter with nothing on screen naming it and nothing but Escape to clear it.
   */
  const chips = () =>
    mineOnly() && quickFilter()
      ? ui.filters.filter((clause) => clause.field !== "assignee")
      : ui.filters;

  return (
    <>
      <div class="flex min-w-0 items-center gap-1">
        {/*
          Your own face as the toggle. A filter by assignee is spelled with an
          avatar everywhere else in the app, and "Me" was the one place it was
          spelled with a word.

          Not the keyed `<Show>{(user) => …}` form, for the reason spelled out
          over the popover below — reading the accessor directly costs nothing
          and cannot go stale.
        */}
        <Show when={quickFilter()}>
          <button
            type="button"
            aria-pressed={mineOnly()}
            aria-label="Only my tasks"
            title="a"
            onClick={toggleMine}
            class="flex h-[22px] shrink-0 items-center rounded-[5px] px-1 transition-colors"
            classList={{
              "bg-accent-soft": mineOnly(),
              /* Greyed rather than faded. The initials on that disc are 7px of
                 white on a workspace colour, and half an opacity takes them
                 from ClickUp's own contrast to unreadable; `grayscale` keeps
                 luminance, so they stay exactly as legible as every other
                 avatar in the app. */
              "grayscale hover:bg-hover hover:grayscale-0": !mineOnly(),
            }}
          >
            <Avatar user={quickFilter()} size={16} />
          </button>
        </Show>

        <For each={chips()}>
          {(clause) => (
            <Chip
              label={describeClause(clause, lookup)}
              onOpen={(anchor) => openAt(clause.field, anchor)}
              onClear={() => setUi("filters", removeClause(ui.filters, clause.field))}
            />
          )}
        </For>

        <button
          ref={addButton}
          type="button"
          aria-label="Add a filter"
          title="F"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openAt(null, { x: rect.left, y: rect.bottom + 6 });
          }}
          class="flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-ink-4 text-xs transition-colors hover:bg-hover hover:text-ink-2"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.5 4h11l-4.2 5v3.6L6.7 14V9L2.5 4Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
          <Show when={ui.filters.length === 0}>Filter</Show>
        </button>
      </div>

      {/*
        Deliberately not `<Show when={open()}>{(state) => …}`.

        That form hands the child a keyed accessor which throws the moment it is
        read after the popover has closed — and every callback below reads the
        open state, including the one that closes it. Solid treats the throw as
        an error inside the owner and tears the whole subtree's reactivity down,
        which looks like a menu that has stopped responding to anything:
        typing no longer filters, Escape no longer closes, and the only clue is
        one line in the console. Reading `open()` directly costs nothing and
        cannot go stale.
      */}
      <Show when={open()}>
        <FilterMenu
          anchor={open()?.anchor ?? { x: 0, y: 0 }}
          field={open()?.field ?? null}
          fields={fields()}
          choices={openField() ? choicesFor(openField() ?? "", sources()) : []}
          clause={current()}
          partial={partial()}
          chosen={(value) => isChosen(current(), openField() ?? "", value)}
          onPickField={(field) => setOpen({ anchor: anchorOf(), field })}
          onBack={() => setOpen({ anchor: anchorOf(), field: null })}
          onToggle={(value) => {
            const field = openField();
            if (!field) return;
            setUi("filters", setClause(ui.filters, applyChoice(current(), field, value)));
          }}
          onNegate={() => {
            const field = openField();
            if (!field) return;
            const base: Clause = current() ?? { field, op: "ANY", values: [] };
            setUi("filters", setClause(ui.filters, { ...base, op: negate(base.op) }));
          }}
          onClose={close}
        />
      </Show>
    </>
  );
}

function Chip(props: {
  label: string;
  onOpen: (anchor: { x: number; y: number }) => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <div class="flex h-[22px] min-w-0 items-center rounded-[5px] bg-accent-soft text-ink">
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpen({ x: rect.left, y: rect.bottom + 6 });
        }}
        class="flex h-full min-w-0 items-center truncate px-1.5 text-xs"
      >
        <span class="truncate">{props.label}</span>
      </button>

      <button
        type="button"
        aria-label={`Remove ${props.label}`}
        onClick={props.onClear}
        class="flex h-full w-4 shrink-0 items-center justify-center text-ink-3 hover:text-ink"
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
    </div>
  );
}
