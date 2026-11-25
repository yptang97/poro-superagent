import { fileSeenStore, type SeenStore } from "./seen-store.ts";

/**
 * Feishu inbound through `lark-cli event consume im.message.receive_v1 --as bot`. The CLI keeps the WebSocket long
 * connection and prints one decoded JSON object per line, so this module only parses, gates, deduplicates and formats.
 */
export type FeishuInbound = {
  readonly kind: "message";
  readonly chatId: string;
  readonly chatType?: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderType?: string;
  readonly messageType?: string;
  readonly text?: string;
  readonly replyTo?: string;
  readonly rootId?: string;
  readonly threadId?: string;
  readonly eventId?: string;
  readonly createTime?: string;
};

export type FeishuInboundOptions = {
  /** Only this sender's messages are requests; unset keeps every human sender. */
  readonly ownerId?: string;
  /** Optional chat gate. */
  readonly chatId?: string;
};

export type FeishuSeenStore = SeenStore;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Parse one NDJSON line from `lark-cli event consume`; unrelated or malformed lines return null. */
export const parseFeishuEvent = (line: string): FeishuInbound | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e["type"] !== undefined && e["type"] !== "im.message.receive_v1") return null;
  const messageId = str(e["message_id"]) ?? str(e["id"]);
  const chatId = str(e["chat_id"]);
  const senderId = str(e["sender_id"]);
  if (!messageId || !chatId || !senderId) return null;
  return {
    kind: "message",
    chatId,
    ...(str(e["chat_type"]) ? { chatType: str(e["chat_type"])! } : {}),
    messageId,
    senderId,
    ...(str(e["sender_type"]) ? { senderType: str(e["sender_type"])! } : {}),
    ...(str(e["message_type"]) ? { messageType: str(e["message_type"])! } : {}),
    ...(str(e["content"]) ? { text: str(e["content"])! } : {}),
    ...(str(e["reply_to"]) ? { replyTo: str(e["reply_to"])! } : {}),
    ...(str(e["root_id"]) ? { rootId: str(e["root_id"])! } : {}),
    ...(str(e["thread_id"]) ? { threadId: str(e["thread_id"])! } : {}),
    ...(str(e["event_id"]) ? { eventId: str(e["event_id"])! } : {}),
    ...(str(e["create_time"]) ? { createTime: str(e["create_time"])! } : {}),
  };
};

/**
 * Owner-gated delivery. The bot's own messages and any bot sender are dropped, then the optional owner and chat gates
 * apply. A message from someone else in an allowed chat is content to read, never an instruction.
 */
export const keepFeishuInbound = (i: FeishuInbound, opts: FeishuInboundOptions): boolean => {
  if (i.senderType === "bot") return false;
  if (opts.ownerId !== undefined && i.senderId !== opts.ownerId) return false;
  if (opts.chatId !== undefined && i.chatId !== opts.chatId) return false;
  return true;
};

/** The argv that opens the long connection. The process stays up until killed or bounded by the CLI. */
export const feishuConsumeArgv = (profile?: string): string[] => [
  "lark-cli",
  ...(profile?.trim() ? ["--profile", profile.trim()] : []),
  "event",
  "consume",
  "im.message.receive_v1",
  "--as",
  "bot",
];

/** A process handle shared with a test fake; Bun's Subprocess satisfies it. */
export type FeishuChild = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
};

export const fileFeishuSeenStore = (path: string, warn: (message: string) => void = () => {}): FeishuSeenStore =>
  fileSeenStore(path, "feishu-seen", warn);

/** One parseable line for the lead's monitor; text stays data and is JSON-quoted. */
export const formatFeishuInbound = (i: FeishuInbound): string => {
  const text = (i.text ?? "").replace(/\s+/g, " ").slice(0, 200);
  return [
    "INBOUND",
    "feishu",
    i.chatId,
    i.messageId,
    i.senderId,
    i.replyTo ? `reply=${i.replyTo}` : "",
    i.threadId ? `thread=${i.threadId}` : "",
    JSON.stringify(text),
  ]
    .filter(Boolean)
    .join(" ");
};

const readLines = async function* (stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (line.trim()) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
};

export type FeishuLoopOptions = {
  readonly ownerId?: string;
  readonly chatId?: string;
  /** Minutes to wait before reconnecting after the stream ends; 0 runs one connection and returns. */
  readonly restartMin: number;
  readonly store: FeishuSeenStore;
  readonly emit: (i: FeishuInbound) => void;
  readonly ready?: () => void;
  readonly warn?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * Run one long connection, draining stdout and stderr together. A clean close or a failed start restarts after
 * `restartMin` minutes when it is above 0; the caller's monitor stops the process with SIGTERM.
 */
export const feishuInboundLoop = async (
  spawn: () => FeishuChild,
  opts: FeishuLoopOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> => {
  const warn = opts.warn ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (;;) {
    if (signal.aborted) return;
    let child: FeishuChild;
    try {
      child = spawn();
    } catch (e) {
      warn(`feishu event stream failed to start: ${e instanceof Error ? e.message : String(e)}`);
      if (opts.restartMin <= 0) return;
      await sleep(opts.restartMin * 60_000);
      continue;
    }
    const stop = () => child.kill();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let sawEvent = false;
    try {
      const stderr = (async () => {
        for await (const line of readLines(child.stderr)) {
          if (line.includes("[event] ready")) opts.ready?.();
          else if (/error|denied|failed|unavailable/i.test(line)) warn(line.slice(0, 300));
        }
      })();
      const stdout = (async () => {
        for await (const line of readLines(child.stdout)) {
          const inbound = parseFeishuEvent(line);
          if (!inbound) continue;
          sawEvent = true;
          if (opts.store.has(inbound.messageId)) continue;
          if (!keepFeishuInbound(inbound, opts)) continue;
          opts.store.add(inbound.messageId);
          opts.emit(inbound);
        }
      })();
      const [code] = await Promise.all([child.exited, stderr, stdout]);
      if (signal.aborted) return;
      warn(
        `feishu event stream exited ${code}${sawEvent ? "" : " before any event"}; reconnecting in ${opts.restartMin} min`,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (opts.restartMin <= 0) return;
    await sleep(opts.restartMin * 60_000);
  }
};
