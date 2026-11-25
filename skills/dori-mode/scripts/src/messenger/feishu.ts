import type { Runner } from "../run.ts";
import { guardText, MessengerError } from "./http.ts";

/**
 * Feishu through `lark-cli`. The CLI owns the app credentials and the tenant token, so this module passes messages as
 * argv (never a shell string) and reads the shortcut's JSON result back. A saved lark-cli profile selects the app:
 * `lark-cli --profile poro im +messages-send ...`.
 */
export type FeishuTarget = { readonly chatId: string };

export type FeishuOptions = {
  readonly profile?: string;
  readonly timeoutMs?: number;
};

type FeishuResult = {
  readonly ok?: boolean;
  readonly data?: { readonly message_id?: string; readonly update_time?: string };
  readonly error?: { readonly code?: number; readonly message?: string };
};

export class Feishu {
  constructor(
    private readonly run: Runner,
    private readonly opts: FeishuOptions = {},
  ) {}

  private argv(tail: readonly string[]): string[] {
    const profile = this.opts.profile?.trim();
    return [
      "lark-cli",
      ...(profile ? ["--profile", profile] : []),
      "im",
      ...tail,
      "--as",
      "bot",
      "--format",
      "json",
    ];
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

  async send(target: FeishuTarget, text: string): Promise<string> {
    const body = await this.call(
      ["+messages-send", "--chat-id", target.chatId, "--text", guardText(text)],
      "send",
    );
    const id = body.data?.message_id;
    if (!id) throw new MessengerError("feishu send: lark-cli returned no message_id", 0);
    return id;
  }

  /** Reply to one message. In a p2p chat this is a normal reply; in a topic chat it stays in that message's thread. */
  async reply(messageId: string, text: string, inThread = false): Promise<string> {
    const body = await this.call(
      [
        "+messages-reply",
        "--message-id",
        messageId,
        "--text",
        guardText(text),
        ...(inThread ? ["--reply-in-thread"] : []),
      ],
      "reply",
    );
    const id = body.data?.message_id;
    if (!id) throw new MessengerError("feishu reply: lark-cli returned no message_id", 0);
    return id;
  }

  /** Edit a message this bot sent. Feishu's edit API accepts bot identity only. */
  async edit(messageId: string, text: string): Promise<void> {
    await this.call(["+messages-edit", "--message-id", messageId, "--text", guardText(text)], "edit");
  }
}
