import { createSignal } from "solid-js";

/**
 * Whether the session is gone.
 *
 * A 401 used to set `window.location.href = "/auth/clickup"`, which sent the
 * browser straight to ClickUp's consent screen with no page in between. That
 * works right up until the sign-in is refused — the workspace gate answers 403
 * to an account outside it — and then there is nowhere to land and nothing
 * saying why. A signal instead, and the shell renders the sign-in page.
 *
 * Global rather than per-request: any call can be the one that discovers the
 * session expired, and every view has to stop showing stale rows when it does.
 */
const [signedOut, setSignedOut] = createSignal(false);

export { signedOut };

export function markSignedOut(): void {
  setSignedOut(true);
}

/**
 * Ends the session here and upstream.
 *
 * The cookie is httpOnly, so only the server can clear it; a client-side
 * forget would leave a live session in the database that the next visit picks
 * straight back up.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch("/auth/logout", { method: "POST" });
  } finally {
    // Even if the request failed, stop showing the workspace. A stale session
    // row is a smaller problem than a screen full of someone else's tasks.
    setSignedOut(true);
  }
}
