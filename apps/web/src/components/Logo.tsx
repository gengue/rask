import type { JSX } from "solid-js";

/**
 * The Rask mark: a geometric R sheared 12 degrees, with a wake bar trailing the
 * stem.
 *
 * This is the compact cut. The full mark carries two wake bars, and they merge
 * into a smear below about 24px — which is every slot the app has. The source
 * and the full-size variants live in `docs/brand`.
 */
export function Logo(props: { size?: number }): JSX.Element {
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
