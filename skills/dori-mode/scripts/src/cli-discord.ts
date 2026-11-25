/** The Discord channel's CLI wiring: gateway socket, inbound loop, ack reaction, and thread lifecycle. */
import { die, type Command } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import { discordInboundLoop, type GatewaySocket } from "./messenger/discord-inbound.ts";
import { formatDiscordInbound } from "./messenger/discord-message.ts";
import { fetchHttp } from "./messenger/http.ts";
import { fileSeenStore } from "./messenger/seen-store.ts";
import { realClock } from "./run.ts";

const token = (): string => process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set");

const socket = (url: string): GatewaySocket => {
  const ws = new WebSocket(url);
  let message: (data: string) => void = () => {};
  let close: (code: number) => void = () => {};
  let closed = false;
  const finish = (code: number): void => {
    if (closed) return;
    closed = true;
    close(code);
  };
  ws.addEventListener("message", (e) => message(String(e.data)));
  ws.addEventListener("close", (e) => finish((e as CloseEvent).code));
  ws.addEventListener("error", () => finish(1006));
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (cb) => {
      message = cb;
    },
    onClose: (cb) => {
      close = cb;
    },
  };
};

export const discordInbound = async (minutes: number, stateDir: string): Promise<void> => {
  const owner = process.env["DORI_DISCORD_OWNER_ID"] ?? die("DORI_DISCORD_OWNER_ID is not set");
  const channel = process.env["DORI_DISCORD_CHANNEL_ID"];
  const warn = (message: string): void => console.log(`WARN ${message}`.slice(0, 300));
  const end = await discordInboundLoop(() => socket("wss://gateway.discord.gg/?v=10&encoding=json"), token(), {
    ownerId: owner,
    ...(channel !== undefined ? { channelId: channel } : {}),
    restartMin: minutes,
    store: fileSeenStore(`${stateDir}/discord-seen.json`, "discord-seen", warn),
    emit: (i) => console.log(formatDiscordInbound(i)),
    ready: (id) => console.log(`INBOUND_READY discord user=${id} owner=${owner} channel=${channel ?? "-"}`),
    warn,
  });
  if (end === "fatal") process.exitCode = 1;
};

export const discordReact: Command = async ({ need, opt }) => {
  const emoji = opt("emoji") || "👀";
  await new Discord(fetchHttp, realClock, token()).react(need("to"), need("message"), emoji);
  console.log(`REACTED ${emoji}`);
};

export const discordThread: Command = async ({ key, need, opt, positionals }) => {
  const dc = new Discord(fetchHttp, realClock, token());
  if (key === "start") {
    console.log(`THREAD ${await dc.startThread(need("to"), need("message"), opt("name") || "task")}`);
    return;
  }
  const threadId = positionals[1] ?? die("thread rename, archive and reopen need a thread id");
  if (key === "rename") await dc.setThread(threadId, { name: opt("name") || die("thread rename needs --name") });
  else if (key === "archive") await dc.setThread(threadId, { archived: true });
  else if (key === "reopen") await dc.setThread(threadId, { archived: false });
  else die("thread needs start, rename, archive or reopen");
  console.log(`THREAD_SET ${threadId}`);
};
