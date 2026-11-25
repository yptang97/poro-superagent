import { expect, test } from "bun:test";

import { Feishu } from "../src/messenger/feishu.ts";
import { MessengerError, UnsafeMessageError } from "../src/messenger/http.ts";
import type { Ran, Runner } from "../src/run.ts";

const ok = (body: unknown): Ran => ({ code: 0, out: JSON.stringify(body), err: "" });

const recorder = (script: (argv: readonly string[], n: number) => Ran) => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return script(argv, calls.length);
  };
  return { run, calls };
};

test("feishu send goes through lark-cli with the poro profile and returns its message id", async () => {
  const { run, calls } = recorder(() => ok({ ok: true, data: { message_id: "om_sent" } }));
  const id = await new Feishu(run, { profile: "poro" }).send({ chatId: "oc_1" }, "你好");
  expect(id).toBe("om_sent");
  expect(calls[0]).toEqual([
    "lark-cli",
    "--profile",
    "poro",
    "im",
    "+messages-send",
    "--chat-id",
    "oc_1",
    "--text",
    "你好",
    "--as",
    "bot",
    "--format",
    "json",
  ]);
});

test("feishu reply and edit use the bot-only shortcuts", async () => {
  const { run, calls } = recorder(() => ok({ ok: true, data: { message_id: "om_new" } }));
  const feishu = new Feishu(run, { profile: "poro" });
  expect(await feishu.reply("om_root", "收到", true)).toBe("om_new");
  await feishu.edit("om_new", "已更新");
  expect(calls[0]?.slice(4, 8)).toEqual(["+messages-reply", "--message-id", "om_root", "--text"]);
  expect(calls[0]).toContain("--reply-in-thread");
  expect(calls[1]?.slice(4, 7)).toEqual(["+messages-edit", "--message-id", "om_new"]);
});

test("without a profile the active lark-cli profile is used", async () => {
  const { run, calls } = recorder(() => ok({ ok: true, data: { message_id: "om_x" } }));
  await new Feishu(run).send({ chatId: "oc_1" }, "hi");
  expect(calls[0]?.includes("--profile")).toBe(false);
});

test("a Feishu error keeps the API message and code", async () => {
  const { run } = recorder(() =>
    ok({ ok: false, error: { code: 99991672, message: "access denied: missing scope" } }),
  );
  const err = await new Feishu(run, { profile: "poro" })
    .send({ chatId: "oc_1" }, "hi")
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MessengerError);
  expect((err as MessengerError).message).toContain("missing scope");
  expect((err as MessengerError).code).toBe("99991672");
});

test("Feishu text carrying a $( substitution is refused before lark-cli runs", async () => {
  const { run, calls } = recorder(() => ok({ ok: true, data: { message_id: "om_x" } }));
  await expect(new Feishu(run).send({ chatId: "oc_1" }, "$(id)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(calls).toHaveLength(0);
});
