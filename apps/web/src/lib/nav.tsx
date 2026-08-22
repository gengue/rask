/**
 * Thin re-export so components import navigation from one place.
 *
 * TanStack Router's `Link` is generic over the route tree, which makes every
 * call site carry the tree's type. `A` pins it once here.
 */
export {
  Link as A,
  useMatchRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
