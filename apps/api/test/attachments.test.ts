import { describe, expect, test } from "bun:test";
import { ENVELOPE_BYTES, readUpload } from "../src/attachments.ts";

/**
 * Reading an upload, which is the only place a request body is not JSON.
 *
 * Every case here is a refusal, because the refusals are the part that has to
 * hold: a cap that trusts `Content-Length` is not a cap, and a missing part
 * that reads as an empty file uploads nothing under a name somebody will later
 * go looking for.
 */

const MAX = 1024;

function upload(
  body: NonNullable<RequestInit["body"]>,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://test/api/tasks/abc/attachments", {
    method: "POST",
    body,
    headers,
  });
}

function withFile(bytes: number, name = "shot.png", field = "file"): Request {
  const form = new FormData();
  form.append(field, new File([new Uint8Array(bytes)], name, { type: "image/png" }));
  return upload(form);
}

describe("readUpload", () => {
  test("takes the file out of the form", async () => {
    const read = await readUpload(withFile(64, "screenshot.png"), MAX);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.name).toBe("screenshot.png");
    expect(read.file.size).toBe(64);
  });

  test("refuses a body that is not multipart", async () => {
    const read = await readUpload(
      upload(JSON.stringify({ file: "nice try" }), { "content-type": "application/json" }),
      MAX,
    );
    expect(read).toMatchObject({ ok: false, status: 400 });
  });

  test("refuses a form with no file part", async () => {
    const form = new FormData();
    form.append("file", "just a string");
    expect(await readUpload(upload(form), MAX)).toMatchObject({ ok: false, status: 400 });
  });

  test("refuses a file under another name, rather than uploading the first part it finds", async () => {
    expect(await readUpload(withFile(64, "shot.png", "attachment"), MAX)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  test("refuses an empty file", async () => {
    expect(await readUpload(withFile(0), MAX)).toMatchObject({ ok: false, status: 400 });
  });

  /**
   * The browser checks the file, the server checks the request, and the
   * difference between the two is the multipart envelope. Without slack for it
   * a file of exactly the limit is refused by a message saying it is inside it.
   */
  test("takes a file of exactly the limit, envelope and all", async () => {
    expect(await readUpload(withFile(MAX), MAX)).toMatchObject({ ok: true });
  });

  test("refuses a body past the cap", async () => {
    const read = await readUpload(withFile(MAX + ENVELOPE_BYTES + 1), MAX);
    expect(read).toMatchObject({ ok: false, status: 413 });
  });

  /**
   * The one that matters. `Content-Length` is written by the caller, so a cap
   * that only reads it is a cap anyone can opt out of by omitting a header —
   * and Bun does exactly that for a streamed body, with no dishonesty required.
   */
  test("refuses an oversized body that declares nothing", async () => {
    const chunk = new Uint8Array(256);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const total = (MAX + ENVELOPE_BYTES) * 2;
        for (let sent = 0; sent < total; sent += chunk.byteLength) controller.enqueue(chunk);
        controller.close();
      },
    });

    const request = new Request("http://test/api/tasks/abc/attachments", {
      method: "POST",
      body: stream,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    });

    expect(request.headers.get("content-length")).toBeNull();
    expect(await readUpload(request, MAX)).toMatchObject({ ok: false, status: 413 });
  });

  test("refuses a lying Content-Length before reading anything", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(64)], "small.png"));
    const honest = new Request("http://test/x", { method: "POST", body: form });
    const type = honest.headers.get("content-type") ?? "";

    const lying = new Request("http://test/api/tasks/abc/attachments", {
      method: "POST",
      body: await honest.arrayBuffer(),
      headers: { "content-type": type, "content-length": String(MAX + ENVELOPE_BYTES + 1) },
    });

    expect(await readUpload(lying, MAX)).toMatchObject({ ok: false, status: 413 });
  });
});
