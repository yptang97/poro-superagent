import { expect, test } from "bun:test";

import { fetchHttp } from "../src/messenger/http.ts";

const bounded = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

test("a 204 answer is read as an empty body instead of blocking on a body that never comes", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  try {
    const res = await bounded(fetchHttp({ method: "PUT", url: `http://127.0.0.1:${server.port}/reactions` }), 3_000);
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
  } finally {
    server.stop(true);
  }
});

test("a normal body, its lowercased headers and an error status still come back", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/fail")
        return new Response("nope", { status: 401, headers: { "X-Trace": "t1" } });
      return Response.json({ ok: true }, { headers: { "X-Trace": "t2" } });
    },
  });
  try {
    const ok = await bounded(fetchHttp({ method: "GET", url: `http://127.0.0.1:${server.port}/ok` }), 3_000);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    expect(ok.headers["x-trace"]).toBe("t2");
    const bad = await bounded(fetchHttp({ method: "GET", url: `http://127.0.0.1:${server.port}/fail` }), 3_000);
    expect(bad.status).toBe(401);
    expect(bad.body).toBe("nope");
  } finally {
    server.stop(true);
  }
});
