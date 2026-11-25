import { expect, test } from "bun:test";

import { DISCORD_INTENTS, discordInboundLoop, type GatewaySocket } from "../src/messenger/discord-inbound.ts";
import type { SeenStore } from "../src/messenger/seen-store.ts";

type Fake = {
  sent: string[];
  socket: GatewaySocket;
  push: (frame: unknown) => void;
  close: (code: number) => void;
  closes: () => number;
};

const fakeSocket = (): Fake => {
  const sent: string[] = [];
  let message: (data: string) => void = () => {};
  let closed: (code: number) => void = () => {};
  let closes = 0;
  return {
    sent,
    socket: {
      send: (data) => sent.push(data),
      close: () => {
        closes += 1;
      },
      onMessage: (cb) => {
        message = cb;
      },
      onClose: (cb) => {
        closed = cb;
      },
    },
    push: (frame) => message(JSON.stringify(frame)),
    close: (code) => closed(code),
    closes: () => closes,
  };
};

const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: {
      setInterval: (cb: () => void) => {
        live.add(cb);
        return cb;
      },
      clearInterval: (h: unknown) => {
        live.delete(h as () => void);
      },
    },
    fire: () => {
      for (const cb of live) cb();
    },
  };
};

const seen = (): SeenStore => {
  const ids = new Set<string>();
  return { has: (id) => ids.has(id), add: (id) => void ids.add(id) };
};

const HELLO = { op: 10, d: { heartbeat_interval: 41250 } };
const ready = (seq: number) => ({ op: 0, s: seq, t: "READY", d: { session_id: "S1", user: { id: "U_BOT" } } });
const base = { id: "M1", channel_id: "C1", guild_id: "G1", author: { id: "U_OWNER", bot: false }, content: "ship it" };
const created = (over: Record<string, unknown> = {}, seq = 2) => ({
  op: 0,
  s: seq,
  t: "MESSAGE_CREATE",
  d: { ...base, ...over },
});

const opener = () => {
  const sockets: Fake[] = [];
  const waits: ((f: Fake) => void)[] = [];
  return {
    sockets,
    open: () => {
      const f = fakeSocket();
      sockets.push(f);
      waits.shift()?.(f);
      return f.socket;
    },
    next: () => new Promise<Fake>((resolve) => waits.push(resolve)),
  };
};

test("identify asks for messages, content and DMs; one owner message is one line and a repeat is dropped", async () => {
  const f = fakeSocket();
  const lines: string[] = [];
  const readyIds: string[] = [];
  const t = fakeTimers();
  const loop = discordInboundLoop(() => f.socket, "BOT", {
    restartMin: 0,
    store: seen(),
    emit: (i) => lines.push(i.messageId),
    ready: (id) => readyIds.push(id),
    timers: t.timers,
  });
  f.push(HELLO);
  expect(DISCORD_INTENTS).toBe(37_376);
  expect(JSON.parse(f.sent[0] ?? "{}")).toEqual({
    op: 2,
    d: {
      token: "BOT",
      intents: DISCORD_INTENTS,
      properties: { os: process.platform, browser: "dori", device: "dori" },
    },
  });
  f.push(ready(1));
  f.push(created());
  f.push(created());
  f.push(created({ id: "M2", author: { id: "U_BOT" } }));
  f.close(4004);
  expect(await loop).toBe("fatal");
  expect(readyIds).toEqual(["U_BOT"]);
  expect(lines).toEqual(["M1"]);
});

test("owner and channel gates apply, and a blank message warns once without a line", async () => {
  const f = fakeSocket();
  const lines: string[] = [];
  const warns: string[] = [];
  const t = fakeTimers();
  const loop = discordInboundLoop(() => f.socket, "BOT", {
    ownerId: "U_OWNER",
    channelId: "C1",
    restartMin: 0,
    store: seen(),
    emit: (i) => lines.push(i.messageId),
    warn: (m) => warns.push(m),
    timers: t.timers,
  });
  f.push(HELLO);
  f.push(ready(1));
  f.push(created({ id: "M2", author: { id: "U_OTHER" } }));
  f.push(created({ id: "M3", channel_id: "C2" }));
  f.push(created({ id: "M4", content: "" }));
  f.push(created({ id: "M5", content: "   " }));
  f.close(4004);
  await loop;
  expect(lines).toEqual([]);
  expect(warns.filter((m) => m.includes("no text"))).toHaveLength(1);
});

test("a reconnect resumes with the session id and the last sequence instead of identifying again", async () => {
  const o = opener();
  const t = fakeTimers();
  const loop = discordInboundLoop(o.open, "BOT", {
    restartMin: 0,
    store: seen(),
    emit: () => {},
    timers: t.timers,
  });
  const first = o.sockets[0]!;
  first.push(HELLO);
  first.push(ready(7));
  first.push(created({}, 8));
  const next = o.next();
  first.push({ op: 7 });
  const second = await next;
  second.push(HELLO);
  expect(JSON.parse(second.sent[0] ?? "{}")).toMatchObject({ op: 6, d: { session_id: "S1", seq: 8 } });
  second.close(4004);
  await loop;
  expect(o.sockets).toHaveLength(2);
});

test("an invalid session that cannot resume identifies again from scratch", async () => {
  const o = opener();
  const t = fakeTimers();
  const loop = discordInboundLoop(o.open, "BOT", {
    restartMin: 0,
    store: seen(),
    emit: () => {},
    timers: t.timers,
  });
  const first = o.sockets[0]!;
  first.push(HELLO);
  first.push(ready(3));
  const next = o.next();
  first.push({ op: 9, d: false });
  const second = await next;
  second.push(HELLO);
  expect(JSON.parse(second.sent[0] ?? "{}").op).toBe(2);
  second.close(4004);
  await loop;
});

test("a heartbeat that is never acknowledged closes the socket, and restartMin 0 ends the loop", async () => {
  const o = opener();
  const t = fakeTimers();
  const loop = discordInboundLoop(o.open, "BOT", {
    restartMin: 0,
    store: seen(),
    emit: () => {},
    timers: t.timers,
  });
  const first = o.sockets[0]!;
  first.push(HELLO);
  t.fire();
  t.fire();
  expect(await loop).toBe("stopped");
  expect(first.closes()).toBe(1);
  expect(first.sent.map((f) => JSON.parse(f).op)).toEqual([2, 1]);
  expect(o.sockets).toHaveLength(1);
});

test("a dropped connection waits restartMin minutes, and a fatal close ends without another try", async () => {
  const o = opener();
  const t = fakeTimers();
  const waits: number[] = [];
  const warns: string[] = [];
  const loop = discordInboundLoop(o.open, "BOT", {
    restartMin: 2,
    store: seen(),
    emit: () => {},
    warn: (m) => warns.push(m),
    sleep: async (ms) => {
      waits.push(ms);
    },
    timers: t.timers,
  });
  const first = o.sockets[0]!;
  first.push(HELLO);
  const next = o.next();
  first.close(1006);
  const second = await next;
  second.push(HELLO);
  second.close(4004);
  await loop;
  expect(waits).toEqual([120_000]);
  expect(o.sockets).toHaveLength(2);
  expect(warns.some((m) => m.includes("authentication failed"))).toBe(true);
});
