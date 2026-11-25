/**
 * Discord inbound over the Gateway WebSocket: one long connection, MESSAGE_CREATE only, owner-gated and deduplicated.
 * The bot token goes in IDENTIFY; Message Content is a privileged intent the developer portal must enable.
 */
import {
  type DiscordInbound,
  type DiscordInboundOptions,
  keepDiscordInbound,
  parseDiscordMessage,
} from "./discord-message.ts";
import type { SeenStore } from "./seen-store.ts";
import { realTimers, type Timers } from "./typing.ts";

/** GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT. */
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

export type GatewaySocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number) => void): void;
};

export type DiscordLoopOptions = DiscordInboundOptions & {
  readonly restartMin: number;
  readonly store: SeenStore;
  readonly emit: (i: DiscordInbound) => void;
  readonly ready?: (userId: string) => void;
  readonly warn?: (message: string) => void;
  readonly timers?: Timers;
  readonly sleep?: (ms: number) => Promise<void>;
};

type SessionState = {
  sessionId: string | undefined;
  seq: number | null;
  userId: string | undefined;
  settled: boolean;
};

type Outcome =
  | { readonly action: "reconnect"; readonly reason: string }
  | { readonly action: "closed"; readonly reason: string }
  | { readonly action: "stop"; readonly reason: string };

const FATAL: Readonly<Record<number, string>> = {
  4004: "authentication failed: check DORI_DISCORD_TOKEN",
  4010: "invalid shard",
  4011: "sharding is required for this bot",
  4012: "invalid gateway API version",
  4013: "invalid intents",
  4014: "disallowed intents: enable Message Content Intent in the Discord Developer Portal",
};
const DROP_SESSION = new Set([4007, 4009]);

const frame = (op: number, d: unknown): string => JSON.stringify({ op, d });

const identify = (token: string): string =>
  frame(2, {
    token,
    intents: DISCORD_INTENTS,
    properties: { os: process.platform, browser: "dori", device: "dori" },
  });

const resume = (token: string, sessionId: string, seq: number | null): string =>
  frame(6, { token, session_id: sessionId, seq });

const runSession = (
  ws: GatewaySocket,
  token: string,
  opts: DiscordLoopOptions,
  state: SessionState,
  timers: Timers,
): Promise<Outcome> =>
  new Promise((resolve) => {
    const warn = opts.warn ?? (() => {});
    let beat: unknown;
    let acked = true;
    let done = false;
    let blankWarned = false;
    const finish = (o: Outcome): void => {
      if (done) return;
      done = true;
      if (beat !== undefined) timers.clearInterval(beat);
      resolve(o);
    };
    ws.onClose((code) => {
      const fatal = FATAL[code];
      if (fatal) return finish({ action: "stop", reason: `discord gateway closed ${code}: ${fatal}` });
      const resumable = state.sessionId !== undefined && !DROP_SESSION.has(code);
      if (!resumable) {
        state.sessionId = undefined;
        state.seq = null;
      }
      return finish({
        action: "closed",
        reason:
          code === 1006
            ? "discord gateway closed 1006 before hello; if this host needs a proxy, set HTTPS_PROXY or ALL_PROXY"
            : `discord gateway closed ${code}${resumable ? "" : " (session lost)"}`,
      });
    });
    ws.onMessage((raw) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const d = typeof m["d"] === "object" && m["d"] !== null ? (m["d"] as Record<string, unknown>) : undefined;
      if (typeof m["s"] === "number") state.seq = m["s"];
      const op = m["op"];
      if (typeof op !== "number") return;
      if (op === 10) {
        const interval = d?.["heartbeat_interval"];
        if (typeof interval !== "number" || interval <= 0)
          return finish({ action: "closed", reason: "hello without a heartbeat interval" });
        beat = timers.setInterval(() => {
          if (done) return;
          if (!acked) {
            ws.close();
            return finish({ action: "closed", reason: "heartbeat was not acknowledged" });
          }
          acked = false;
          ws.send(frame(1, state.seq));
        }, interval);
        if (state.sessionId !== undefined) ws.send(resume(token, state.sessionId, state.seq));
        else ws.send(identify(token));
        return;
      }
      if (op === 11) {
        acked = true;
        return;
      }
      if (op === 1) {
        ws.send(frame(1, state.seq));
        return;
      }
      if (op === 7) {
        ws.close();
        return finish({ action: "reconnect", reason: "gateway asked to reconnect" });
      }
      if (op === 9) {
        if (m["d"] !== true) {
          state.sessionId = undefined;
          state.seq = null;
        }
        ws.close();
        return finish({ action: "reconnect", reason: "invalid session" });
      }
      if (op !== 0) return;
      const t = m["t"];
      if (t === "READY") {
        const id = d?.["session_id"];
        state.sessionId = typeof id === "string" && id ? id : undefined;
        const user = d?.["user"];
        const userId = typeof user === "object" && user !== null ? (user as Record<string, unknown>)["id"] : undefined;
        state.userId = typeof userId === "string" ? userId : undefined;
        state.settled = true;
        opts.ready?.(state.userId ?? "-");
        return;
      }
      if (t === "RESUMED") {
        state.settled = true;
        return;
      }
      if (t !== "MESSAGE_CREATE") return;
      const inbound = parseDiscordMessage(d);
      if (!inbound || opts.store.has(inbound.messageId)) return;
      if (!keepDiscordInbound(inbound, opts, state.userId)) return;
      opts.store.add(inbound.messageId);
      if (!inbound.text.trim()) {
        if (!blankWarned) {
          blankWarned = true;
          warn("a message arrived with no text (enable Message Content Intent to read guild messages)");
        }
        return;
      }
      opts.emit(inbound);
    });
  });

export const discordInboundLoop = async (
  open: () => GatewaySocket,
  token: string,
  opts: DiscordLoopOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<"stopped" | "fatal"> => {
  const warn = opts.warn ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const timers = opts.timers ?? realTimers;
  const state: SessionState = { sessionId: undefined, seq: null, userId: undefined, settled: false };
  let unsettled = 0;
  for (;;) {
    if (signal.aborted) return "stopped";
    let ws: GatewaySocket;
    try {
      ws = open();
    } catch (e) {
      warn(`discord gateway failed to open: ${e instanceof Error ? e.message : String(e)}`);
      if (opts.restartMin <= 0) return "stopped";
      await sleep(opts.restartMin * 60_000);
      continue;
    }
    state.settled = false;
    const outcome = await runSession(ws, token, opts, state, timers);
    if (outcome.action === "stop") {
      warn(outcome.reason);
      return "fatal";
    }
    if (outcome.action === "closed") {
      if (opts.restartMin <= 0) {
        warn(`${outcome.reason}; not reconnecting (--loop 0)`);
        return "stopped";
      }
      warn(`${outcome.reason}; reconnecting in ${opts.restartMin} min`);
      await sleep(opts.restartMin * 60_000);
      continue;
    }
    if (state.settled) {
      unsettled = 0;
      continue;
    }
    if (++unsettled < 2) continue;
    unsettled = 0;
    warn(`${outcome.reason} before the session settled`);
    if (opts.restartMin <= 0) return "stopped";
    warn(`waiting ${opts.restartMin} min before the next try`);
    await sleep(opts.restartMin * 60_000);
  }
};
