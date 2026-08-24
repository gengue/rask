import { MAX_ATTACHMENT_BYTES, UPLOAD_FIELD } from "@rask/clickup-client/vocabulary";
import { readCappedBytes } from "./webhooks.ts";

/**
 * Reading the one multipart request in the app.
 *
 * Uploads are the only place a signed-in user hands the API bytes rather than
 * JSON, so they are the only place a request can be arbitrarily large. The cap
 * is enforced on the stream and not on `Content-Length` for the same reason the
 * webhook route does it: the caller writes that header and can simply lie, and
 * a session is not a reason to buffer a gigabyte.
 *
 * Refusals come back as data rather than thrown, because every one of them is
 * an answer the route sends verbatim — there is no failure here that anyone
 * should be logging a stack trace for.
 */

export type UploadRead = { ok: true; file: File } | { ok: false; status: 400 | 413; error: string };

/**
 * What the multipart envelope is allowed to add on top of the file.
 *
 * The cap is read off the file in the browser and off the whole request here,
 * so without this a file of exactly the limit is refused by the server with a
 * message saying it is within it. Part headers are a few hundred bytes; the
 * slack is deliberately far more than that and still nowhere near a second
 * file.
 */
export const ENVELOPE_BYTES = 8 * 1024;

export async function readUpload(
  request: Request,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): Promise<UploadRead> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return { ok: false, status: 400, error: "expected multipart/form-data" };
  }

  const body = await readCappedBytes(request, maxBytes + ENVELOPE_BYTES);
  if (body === null) return tooLarge(maxBytes);

  /*
   * Re-parsed from the bytes rather than through `request.formData()`, which
   * would read the stream itself and leave nothing to cap.
   */
  const form = await new Response(body, { headers: { "content-type": contentType } })
    .formData()
    .catch(() => null);
  if (!form) return { ok: false, status: 400, error: "could not read the upload" };

  const file = form.get(UPLOAD_FIELD);
  if (!(file instanceof File)) return { ok: false, status: 400, error: "no file in the upload" };
  // ClickUp accepts an empty file and stores a 0-byte attachment nobody can
  // use. A drag that picked up a folder arrives looking exactly like this.
  if (file.size === 0) return { ok: false, status: 400, error: "that file is empty" };

  return { ok: true, file };
}

function tooLarge(maxBytes: number): UploadRead {
  return {
    ok: false,
    status: 413,
    error: `files are limited to ${Math.round(maxBytes / (1024 * 1024))}MB`,
  };
}
