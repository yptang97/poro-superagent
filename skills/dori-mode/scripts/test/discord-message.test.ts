import { expect, test } from "bun:test";

import { formatDiscordInbound, keepDiscordInbound, parseDiscordMessage } from "../src/messenger/discord-message.ts";

const event = {
  id: "M1",
  channel_id: "C1",
  guild_id: "G1",
  author: { id: "U_OWNER", bot: false },
  content: "ship it",
  attachments: [{ id: "A1" }, { id: "A2" }],
};

test("a guild message parses into the inbound shape, and a thread id arrives as the channel", () => {
  expect(parseDiscordMessage(event)).toEqual({
    channelId: "C1",
    messageId: "M1",
    authorId: "U_OWNER",
    text: "ship it",
    guildId: "G1",
    files: 2,
    fromBot: false,
  });
  expect(parseDiscordMessage({ ...event, channel_id: "T1" })).toMatchObject({ channelId: "T1" });
  expect(parseDiscordMessage({ id: "M1", author: { id: "U" } })).toBeNull();
  expect(parseDiscordMessage({ ...event, author: { bot: true } })).toBeNull();
});

test("owner and channel gates drop bots, the bot itself, other people and other channels", () => {
  const parsed = parseDiscordMessage(event)!;
  expect(keepDiscordInbound(parsed, { ownerId: "U_OWNER", channelId: "C1" }, "U_BOT")).toBe(true);
  expect(keepDiscordInbound(parsed, { ownerId: "U_OTHER" }, "U_BOT")).toBe(false);
  expect(keepDiscordInbound(parsed, { channelId: "C2" }, "U_BOT")).toBe(false);
  expect(keepDiscordInbound(parsed, {}, "U_OWNER")).toBe(false);
  expect(keepDiscordInbound({ ...parsed, fromBot: true }, {}, "U_BOT")).toBe(false);
  expect(keepDiscordInbound(parsed, {}, undefined)).toBe(true);
});

test("the inbound line is one parseable record with the text JSON-quoted", () => {
  const parsed = parseDiscordMessage(event)!;
  expect(formatDiscordInbound(parsed)).toBe('INBOUND discord C1 M1 U_OWNER guild=G1 files=2 "ship it"');
  const { guildId: _guild, ...noGuild } = parsed;
  expect(formatDiscordInbound({ ...noGuild, files: 0, text: "a\n  b" })).toBe('INBOUND discord C1 M1 U_OWNER "a b"');
});
