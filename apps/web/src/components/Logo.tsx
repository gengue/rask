import type { JSX } from "solid-js";

/**
 * The Rask mark: a geometric R sheared 12 degrees, with bars trailing the stem.
 *
 * Two cuts, because it does not survive being shrunk without help. This is the
 * full one — two wake bars, stroke 14 — and it wants 24px or more. Below that
 * the bars merge into a smear and you want `LogoCompact` instead.
 *
 * The source lives in `docs/brand/rask-mark.svg` and is duplicated here on
 * purpose: an `<img>` would be a second request for something this small, and
 * inlining is what lets `currentColor` follow the theme. The two have to be
 * changed together.
 */
export function Logo(props: { size?: number }): JSX.Element {
  const size = () => props.size ?? 36;

  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 100 100"
      fill="none"
      class="shrink-0 text-ink"
      aria-hidden="true"
    >
      <g transform="translate(17,0) skewX(-12)">
        <g fill="currentColor">
          <rect x="20" y="26" width="5" height="48" rx="2.5" />
          <rect x="11" y="26" width="3" height="48" rx="1.5" />
        </g>
        <g stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">
          <path d="M 34 22 L 34 78" />
          <path d="M 34 22 H 54 A 17 17 0 0 1 54 56 H 34" />
          <path d="M 48 56 L 74 78" />
        </g>
      </g>
    </svg>
  );
}

/**
 * The small cut: one wake bar, heavier stroke so the counter stays open.
 *
 * For 16–24px, which is every slot inside the app. Mirrors
 * `docs/brand/rask-mark-compact.svg` and `apps/web/public/favicon.svg`.
 */
export function LogoCompact(props: { size?: number }): JSX.Element {
  const size = () => props.size ?? 20;

  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 100 100"
      fill="none"
      class="shrink-0 text-ink"
      aria-hidden="true"
    >
      <g transform="translate(15,0) skewX(-12)">
        <rect x="17" y="26" width="7" height="48" rx="3.5" fill="currentColor" />
        <g stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
          <path d="M 36 24 L 36 76" />
          <path d="M 36 24 H 54 A 16 16 0 0 1 54 56 H 36" />
          <path d="M 49 56 L 72 76" />
        </g>
      </g>
    </svg>
  );
}
