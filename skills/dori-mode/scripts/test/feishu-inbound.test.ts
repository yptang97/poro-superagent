import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  feishuConsumeArgv,
  type FeishuChild,
  feishuInboundLoop,
  fileFeishuSeenStore,
  formatFeishuInbound,
  keepFeishuInbound,
  parseFeishuEvent,
} from "../src/messenger/feishu-inbound.ts";
import { withState } from "./fakes.ts";

const event = {
  type: "im.message.receive_v1",
  event_id: "ev_1",
  timestamp: "1795536740008",
  id: "om_legacy",
  message_id: "om_1",
  create_time: "1795536739627",
  chat_id: "oc_1",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_owner",
  sender_type: "user",
  content: "你好",
};

const streamOf = (lines: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });

test("a real Feishu receive event parses into the inbound shape", () => {
  const parsed = parseFeishuEvent(JSON.stringify(event));
  expect(parsed).toMatchObject({
    chatId: "oc_1",
    chatType: "p2p",
    messageId: "om_1",
    senderId: "ou_owner",
    senderType: "user",
    messageType: "text",
    text: "你好",
    eventId: "ev_1",
  });
  expect(parseFeishuEvent("not json")).toBeNull();
  expect(parseFeishuEvent(JSON.stringify({ ...event, type: "im.chat.updated_v1" }))).toBeNull();
  expect(parseFeishuEvent(JSON.stringify({ ...event, message_id: undefined, id: undefined }))).toBeNull();
});

test("owner and chat gates drop other people, bots and other chats", () => {
  const parsed = parseFeishuEvent(JSON.stringify(event))!;
  expect(keepFeishuInbound(parsed, { ownerId: "ou_owner", chatId: "oc_1" })).toBe(true);
  expect(keepFeishuInbound(parsed, { ownerId: "ou_other" })).toBe(false);
  expect(keepFeishuInbound(parsed, { chatId: "oc_other" })).toBe(false);
  expect(keepFeishuInbound({ ...parsed, senderType: "bot" }, {})).toBe(false);
  expect(keepFeishuInbound(parsed, {})).toBe(true);
});

test("the inbound line is one parseable record with text JSON-quoted", () => {
  const parsed = parseFeishuEvent(JSON.stringify({ ...event, reply_to: "om_root", thread_id: "omt_1" }))!;
  expect(formatFeishuInbound(parsed)).toBe(
    'INBOUND feishu oc_1 om_1 ou_owner reply=om_root thread=omt_1 "你好"',
  );
});

test("the seen store persists message ids and starts empty when the file is corrupt", () => {
  const state = withState();
  try {
    const path = join(state.dir, "seen", "feishu.json");
    const first = fileFeishuSeenStore(path);
    expect(first.has("om_1")).toBe(false);
    first.add("om_1");
    const second = fileFeishuSeenStore(path);
    expect(second.has("om_1")).toBe(true);

    writeFileSync(path, "{broken");
    const warned: string[] = [];
    const third = fileFeishuSeenStore(path, (m) => warned.push(m));
    expect(third.has("om_1")).toBe(false);
    expect(warned).toHaveLength(1);
  } finally {
    state.done();
  }
});

test("the consume argv names the receive event and the bot identity", () => {
  expect(feishuConsumeArgv("dori")).toEqual([
    "lark-cli",
    "--profile",
    "dori",
    "event",
    "consume",
    "im.message.receive_v1",
    "--as",
    "bot",
  ]);
});

test("the loop emits owner messages once, prints ready, and drops everyone else", async () => {
  const state = withState();
  try {
    const store = fileFeishuSeenStore(join(state.dir, "seen.json"));
    const lines = [
      JSON.stringify(event),
      JSON.stringify(event),
      JSON.stringify({ ...event, message_id: "om_2", chat_id: "oc_2", sender_id: "ou_other" }),
      JSON.stringify({ ...event, message_id: "om_3", sender_type: "bot" }),
      JSON.stringify({ ...event, message_id: "om_4", content: "第二条" }),
    ];
    const ready: string[] = [];
    const emitted: string[] = [];
    const child: FeishuChild = {
      stdout: streamOf(lines),
      stderr: streamOf(["[event] ready event_key=im.message.receive_v1"]),
      exited: Promise.resolve(0),
      kill() {},
    };
    await feishuInboundLoop(
      () => child,
      {
        ownerId: "ou_owner",
        chatId: "oc_1",
        restartMin: 0,
        store,
        emit: (i) => emitted.push(i.messageId),
        ready: () => ready.push("ready"),
      },
    );
    expect(ready).toEqual(["ready"]);
    expect(emitted).toEqual(["om_1", "om_4"]);
  } finally {
    state.done();
  }
});
