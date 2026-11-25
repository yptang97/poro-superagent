import { expect, test } from "bun:test";

import { deliver, finish, parseChannelRef, type ReplyTargets } from "../src/cli-reply.ts";

const fakeTargets = () => {
  const calls: string[] = [];
  const targets: ReplyTargets = {
    feishu: {
      reply: async (message, text) => {
        calls.push(`feishu.reply ${message} ${text}`);
        return "om_sent";
      },
      send: async (chat, text) => {
        calls.push(`feishu.send ${chat} ${text}`);
        return "om_end";
      },
    },
    discord: {
      send: async (channel, text) => {
        calls.push(`discord.send ${channel} ${text}`);
        return "M_end";
      },
      setThread: async (id, patch) => {
        calls.push(`discord.setThread ${id} ${JSON.stringify(patch)}`);
      },
    },
  };
  return { targets, calls };
};

test("a ref names its channel, and anything else is refused with the shape it expected", () => {
  expect(parseChannelRef("feishu:oc_1:om_1")).toEqual({ kind: "feishu", chat: "oc_1", message: "om_1" });
  expect(parseChannelRef("discord:123")).toEqual({ kind: "discord", target: "123" });
  expect(parseChannelRef("discord-thread:456")).toEqual({ kind: "discord-thread", target: "456" });
  expect(() => parseChannelRef("feishu:oc_1")).toThrow(/feishu:<chat>:<message>/);
  expect(() => parseChannelRef("discord:")).toThrow(/discord:<id>/);
  expect(() => parseChannelRef("slack:C1")).toThrow(/must start with/);
});

test("a reply follows the ref, so a Discord job never lands in Feishu", async () => {
  const { targets, calls } = fakeTargets();
  expect(await deliver(parseChannelRef("feishu:oc_1:om_1"), "hi", targets)).toBe("om_sent");
  expect(await deliver(parseChannelRef("discord:123"), "hi", targets)).toBe("M_end");
  expect(calls).toEqual(["feishu.reply om_1 hi", "discord.send 123 hi"]);
});

test("finishing a job posts to its own channel, archives a Discord thread, and never touches the other one", async () => {
  const { targets, calls } = fakeTargets();
  await finish(parseChannelRef("feishu:oc_1:om_1"), "done", undefined, targets);
  await finish(parseChannelRef("discord:123"), "done", "[done] fix", targets);
  await finish(parseChannelRef("discord-thread:456"), "done", "[done] fix", targets);
  expect(calls).toEqual([
    "feishu.send oc_1 done",
    "discord.send 123 done",
    "discord.send 456 done",
    'discord.setThread 456 {"archived":true,"name":"[done] fix"}',
  ]);
});
