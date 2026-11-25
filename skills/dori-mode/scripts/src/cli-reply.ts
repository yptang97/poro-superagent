/** One reply path for every channel: the ref a lane was launched with says where its messages came from. */
import { die, type Command } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";
import { Discord } from "./messenger/discord.ts";
import { Feishu } from "./messenger/feishu.ts";
import { fetchHttp } from "./messenger/http.ts";
import { realClock, run } from "./run.ts";

export type ChannelRef =
  | { readonly kind: "feishu"; readonly chat: string; readonly message: string }
  | { readonly kind: "discord"; readonly target: string }
  | { readonly kind: "discord-thread"; readonly target: string };

const parts = (ref: string): string[] => ref.split(":").map((part) => part.trim());

export const parseChannelRef = (ref: string): ChannelRef => {
  const [kind, ...rest] = parts(ref);
  if (kind === "feishu") {
    const [chat, message] = rest;
    if (!chat || !message) throw new Error(`channel ref "${ref}" needs feishu:<chat>:<message>`);
    return { kind: "feishu", chat, message };
  }
  if (kind === "discord" || kind === "discord-thread") {
    const target = rest[0];
    if (!target) throw new Error(`channel ref "${ref}" needs ${kind}:<id>`);
    return { kind, target };
  }
  throw new Error(`channel ref "${ref}" must start with feishu:, discord: or discord-thread:`);
};

export type ReplyTargets = {
  readonly feishu: {
    reply(message: string, text: string): Promise<string>;
    send(chat: string, text: string): Promise<string>;
  };
  readonly discord: {
    send(channel: string, text: string): Promise<string>;
    setThread(id: string, patch: { readonly archived?: boolean; readonly name?: string }): Promise<void>;
  };
};

export const deliver = async (ref: ChannelRef, text: string, targets: ReplyTargets): Promise<string> => {
  if (ref.kind === "feishu") return await targets.feishu.reply(ref.message, text);
  return await targets.discord.send(ref.target, text);
};

export const finish = async (
  ref: ChannelRef,
  text: string,
  name: string | undefined,
  targets: ReplyTargets,
): Promise<string> => {
  if (ref.kind === "feishu") return await targets.feishu.send(ref.chat, text);
  const id = await targets.discord.send(ref.target, text);
  if (ref.kind === "discord-thread")
    await targets.discord.setThread(ref.target, { archived: true, ...(name ? { name } : {}) });
  return id;
};

const targetsFor = (config: DoriConfig): ReplyTargets => {
  const profile = process.env["DORI_FEISHU_PROFILE"] ?? config.feishu.profile;
  const token = process.env["DORI_DISCORD_TOKEN"];
  const feishu = new Feishu(run, profile === undefined ? {} : { profile });
  return {
    feishu: {
      reply: (message, text) => feishu.reply(message, text),
      send: (chat, text) => feishu.send({ chatId: chat }, text),
    },
    discord: new Discord(fetchHttp, realClock, token ?? ""),
  };
};

const refOf = (positionals: readonly string[]): ChannelRef => {
  const raw =
    positionals[0] ?? die("a channel ref is required, e.g. feishu:oc_1:om_1 or discord:123 or discord-thread:456");
  try {
    return parseChannelRef(raw);
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
};

export const replyCommands: Readonly<Record<string, Command>> = {
  reply: async ({ positionals, need, config }) => {
    console.log(`REPLIED ${await deliver(refOf(positionals), need("text"), targetsFor(config))}`);
  },
  finish: async ({ positionals, need, opt, config }) => {
    const ref = refOf(positionals);
    console.log(`FINISHED ${await finish(ref, need("text"), opt("name"), targetsFor(config))}`);
  },
};
