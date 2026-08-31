import { ClickUpError } from "@rask/clickup-client";

/**
 * ClickUp's refusals reach the user; its outages do not pretend to be one.
 *
 * 4xx is an answer the person should read — "you cannot edit someone else's
 * entry" is the common one, since Rask has no way to know who is an admin, and
 * "you do not have edit access to this Doc" is the same shape.
 *
 * It is deliberately not forwarded verbatim: a 401 from ClickUp means *our*
 * stored token has gone bad, and the browser treats a 401 of its own as its
 * session ending and signs the person out of Rask over a section they
 * expanded. So a 401 upstream leaves here as a 502.
 *
 * Lives in its own module because both write-through corners of the API need
 * it — time tracking and Docs — and neither is the other's home.
 */
export function upstream(error: unknown): { status: 422 | 502; error: string } {
  if (error instanceof ClickUpError) {
    const status = error.status >= 400 && error.status < 500 && error.status !== 401 ? 422 : 502;
    return { status, error: error.message };
  }
  return { status: 502, error: error instanceof Error ? error.message : "ClickUp call failed" };
}
