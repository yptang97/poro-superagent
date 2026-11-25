/** One Discord MESSAGE_CREATE, normalized to what a channel consumer needs; no gateway state lives here. */
export type DiscordInbound = {
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly text: string;
  readonly guildId?: string;
  readonly files: number;
  readonly fromBot: boolean;
};

export type DiscordInboundOptions = {
  readonly ownerId?: string;
  readonly channelId?: string;
};

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const parseDiscordMessage = (d: unknown): DiscordInbound | null => {
  const m = rec(d);
  if (!m) return null;
  const author = rec(m["author"]);
  const channelId = str(m["channel_id"]);
  const messageId = str(m["id"]);
  const authorId = str(author?.["id"]);
  if (!channelId || !messageId || !authorId) return null;
  const guildId = str(m["guild_id"]);
  return {
    channelId,
    messageId,
    authorId,
    text: typeof m["content"] === "string" ? m["content"] : "",
    ...(guildId ? { guildId } : {}),
    files: Array.isArray(m["attachments"]) ? m["attachments"].length : 0,
    fromBot: author?.["bot"] === true,
  };
};

export const keepDiscordInbound = (
  i: DiscordInbound,
  opts: DiscordInboundOptions,
  selfId: string | undefined,
): boolean => {
  if (i.fromBot || i.authorId === selfId) return false;
  if (opts.ownerId !== undefined && i.authorId !== opts.ownerId) return false;
  if (opts.channelId !== undefined && i.channelId !== opts.channelId) return false;
  return true;
};

export const formatDiscordInbound = (i: DiscordInbound): string =>
  [
    "INBOUND",
    "discord",
    i.channelId,
    i.messageId,
    i.authorId,
    ...(i.guildId ? [`guild=${i.guildId}`] : []),
    ...(i.files ? [`files=${i.files}`] : []),
    JSON.stringify(i.text.replace(/\s+/g, " ").slice(0, 200)),
  ].join(" ");
