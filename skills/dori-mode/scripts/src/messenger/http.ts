import type { Clock } from "../run.ts";
import { envProxy } from "../proxy-env.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
};
export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

// Bun reads the proxy environment at process start, so a proxy set at run time must be passed explicitly.
export const fetchHttp: Http = async (req) => {
  const proxy = envProxy();
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    ...(proxy ? { proxy } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  // A 204/205/304 has no body; reading it hangs behind a proxy on Bun, and Discord answers a reaction with 204.
  if (res.status === 204 || res.status === 205 || res.status === 304) return { status: res.status, headers, body: "" };
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$("))
    throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return text;
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

export const withBackoff = async (
  http: Http,
  clock: Clock,
  req: HttpRequest,
  policy: RetryPolicy = DEFAULT_RETRY,
  retryAfterFromBody?: (body: string) => number | undefined,
): Promise<HttpResponse> => {
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    last = await http(req);
    if (last.status !== 429 && last.status < 500) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = Number.isFinite(header) && header > 0 ? header : fromBody;
    const waitMs = waitS !== undefined ? waitS * 1000 : Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    if (attempt < policy.attempts - 1) await clock.sleep(Math.min(policy.maxMs, waitMs));
  }
  return last as HttpResponse;
};
