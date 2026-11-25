import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Runner } from "../run.ts";
import { guardText, MessengerError } from "./http.ts";

type FeishuText = { readonly value: string; readonly cleanup: () => void };

const INLINE_LIMIT = 4_000;

/** Bun cuts a multi-line argv value at the first newline when it spawns a non-Bun child on Windows, so long or multi-line text travels as a temp file that lark-cli reads through `@path`. */
const textArg = (text: string): FeishuText => {
  if (!text.includes("\n") && text.length <= INLINE_LIMIT) return { value: text, cleanup: () => {} };
  const path = join(tmpdir(), `dori-feishu-${process.pid}-${crypto.randomUUID()}.txt`);
  writeFileSync(path, text, "utf8");
  return { value: `@${path}`, cleanup: () => rmSync(path, { force: true }) };
};

/**
 * Feishu through `lark-cli`. The CLI owns the app credentials and the tenant token, so this module passes messages as
 * argv (never a shell string) and reads the shortcut's JSON result back. A saved lark-cli profile selects the app:
 * `lark-cli --profile <name> im +messages-send ...`.
 */
export type FeishuTarget = { readonly chatId: string };

export type FeishuOptions = {
  readonly profile?: string;
  readonly timeoutMs?: number;
};

type FeishuResult = {
  readonly ok?: boolean;
  readonly data?: { readonly message_id?: string; readonly update_time?: string; readonly reaction_id?: string };
  readonly error?: { readonly code?: number; readonly message?: string };
};

export class Feishu {
  constructor(
    private readonly run: Runner,
    private readonly opts: FeishuOptions = {},
  ) {}

  private argv(tail: readonly string[]): string[] {
    const profile = this.opts.profile?.trim();
    return ["lark-cli", ...(profile ? ["--profile", profile] : []), "im", ...tail, "--as", "bot", "--format", "json"];
  }

  private async call(tail: readonly string[], what: string): Promise<FeishuResult> {
    const r = await this.run(this.argv(tail), { timeoutMs: this.opts.timeoutMs ?? 60_000 });
    let body: FeishuResult;
    try {
      body = JSON.parse(r.out || "{}") as FeishuResult;
    } catch {
      throw new MessengerError(
        `feishu ${what}: lark-cli returned no JSON${r.err ? `: ${r.err.slice(0, 160)}` : ""}`,
        r.code,
      );
    }
    if (r.code !== 0 || body.ok !== true) {
      throw new MessengerError(
        `feishu ${what}: ${body.error?.message ?? (r.err.trim() || r.out.trim() || "failed")}`.slice(0, 400),
        r.code,
        body.error?.code !== undefined ? String(body.error.code) : undefined,
      );
    }
    return body;
  }

  private async withText(text: string, tail: (value: string) => string[], what: string): Promise<FeishuResult> {
    const arg = textArg(guardText(text));
    try {
      return await this.call(tail(arg.value), what);
    } finally {
      arg.cleanup();
    }
  }

  async send(target: FeishuTarget, text: string): Promise<string> {
    const body = await this.withText(
      text,
      (value) => ["+messages-send", "--chat-id", target.chatId, "--text", value],
      "send",
    );
    const id = body.data?.message_id;
    if (!id) throw new MessengerError("feishu send: lark-cli returned no message_id", 0);
    return id;
  }

  /** Reply to one message. In a p2p chat this is a normal reply; in a topic chat it stays in that message's thread. */
  async reply(messageId: string, text: string, inThread = false): Promise<string> {
    const body = await this.withText(
      text,
      (value) => [
        "+messages-reply",
        "--message-id",
        messageId,
        "--text",
        value,
        ...(inThread ? ["--reply-in-thread"] : []),
      ],
      "reply",
    );
    const id = body.data?.message_id;
    if (!id) throw new MessengerError("feishu reply: lark-cli returned no message_id", 0);
    return id;
  }

  /** Add an emoji reaction: the receipt the lead shows before it answers. Needs im:message and im:message.reactions:write_only. */
  async react(messageId: string, emojiType: string): Promise<string> {
    const body = await this.call(
      [
        "reactions",
        "create",
        "--message-id",
        messageId,
        "--data",
        JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      ],
      "react",
    );
    const id = body.data?.reaction_id;
    if (!id) throw new MessengerError("feishu react: lark-cli returned no reaction_id", 0);
    return id;
  }

  /** Edit a message this bot sent. Feishu's edit API accepts bot identity only. */
  async edit(messageId: string, text: string): Promise<void> {
    await this.withText(text, (value) => ["+messages-edit", "--message-id", messageId, "--text", value], "edit");
  }
}
