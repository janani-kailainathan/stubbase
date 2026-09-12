/**
 * Response helpers shared by the Core Engine and its feature modules.
 *
 * Every response body on the public plane is built by `json()`, and two things
 * depend on that: usage metering reads `content-length` instead of cloning a
 * body, and the live request log reads the already-serialized text out of
 * `serializedBody` instead of buffering a second copy. A feature module that
 * built its own `Response` would quietly drop out of both — import from here.
 */

/**
 * Already-serialized body text, keyed by the Response that carries it. Weak, so
 * entries vanish with the Response itself.
 */
export const serializedBody = new WeakMap<Response, string>();

/** Serializes once and declares content-length, so metering never clones a body. */
export const json = (data: unknown, status = 200) => {
  const body = JSON.stringify(data) ?? "null";
  const res = new Response(body, {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
  serializedBody.set(res, body);
  return res;
};

export const err = (status: number, message: string) => json({ error: message }, status);
