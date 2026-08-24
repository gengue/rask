/**
 * Why a sign-in was refused, in words.
 *
 * The API sends a code rather than a sentence so the wording lives with the UI
 * and a redirect URL carries nothing a stranger can read off the address bar.
 * An unknown code falls through to a generic line instead of showing the code
 * itself, which would mean nothing to the person reading it.
 */
export function signInError(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case "not_a_member":
      return "That ClickUp account is not a member of this workspace.";
    case "not_allowed":
      return "That account is not on the allow list for this deployment.";
    case "no_workspace":
      return "That ClickUp account has no workspace.";
    case "state_mismatch":
      return "The sign-in expired before it finished. Try again.";
    default:
      return "Sign-in did not complete. Try again.";
  }
}
