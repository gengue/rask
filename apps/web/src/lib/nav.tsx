/**
 * Thin re-export so components import navigation from one place.
 *
 * TanStack Router's `Link` is generic over the route tree, which makes every
 * call site carry the tree's type. `A` pins it once here.
 */
import { useNavigate, useSearch } from "@tanstack/solid-router";

export {
  Link as A,
  useMatchRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";

/**
 * Whether the open task fills the panel, read from and written to the URL.
 *
 * It lives in the address for the same reason the open task does: these links
 * get sent to people. "Look at this task" and "look at this task, full width"
 * are different things to send, and the second one used to be unsendable.
 *
 * `replace` because `f` is a keystroke, not a place. Pushing would make Back
 * undo a toggle instead of leaving the task, which is the one thing `lib/ui.ts`
 * warns about keeping view state in the URL.
 */
export function useExpanded(): readonly [() => boolean, (next: boolean) => void] {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  return [
    () => {
      // Only alongside an open task. On its own the flag describes nothing, and
      // the shell hides the list for it: `?expanded=1` with the task lost off
      // the end of a pasted link would otherwise be a blank window.
      const current = search() as { task?: string; expanded?: boolean };
      return current.expanded === true && typeof current.task === "string";
    },
    (next: boolean) =>
      void navigate({
        to: ".",
        replace: true,
        // Absent rather than `expanded=false`: the default belongs in the code,
        // not in every URL somebody copies out of the address bar.
        search: (prev: Record<string, unknown>) => ({ ...prev, expanded: next || undefined }),
      }),
  ] as const;
}
