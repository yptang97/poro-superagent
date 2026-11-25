# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 1. herdr or hc

The Dori runs its sessions on one of two runtimes. herdr is a terminal multiplexer: every lane is a herdr tab, and herdr lets you read a pane, type into it and see which process runs there. hc (herdr-core) keeps each lane in its own terminal, labelled with the lane key, and learns the agent's status only from the agent's own OSC 7501 report (recent omo builds send it).

herdr:

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi        # or the integration for the agent you run in
herdr --skill                       # load its skill unless it is already in your context
```

hc:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
mkdir -p ~/.config/herdr-core && echo 'notes = false' >> ~/.config/herdr-core/config.toml
hc --skill                          # load its skill unless it is already in your context
```

`notes = false` stops hc from typing notes into a parent agent on its own, so the Dori's own sends are the only text that reaches a lane. With both installed, the Dori runs on hc unless `"runtime": "herdr"` is set in step 4; with only one on PATH, it uses that one.

## 2. Messenger (Feishu in this fork)

This fork talks to Feishu through `lark-cli`, not agent-messenger. Add the app as an isolated profile once, feeding the secret on stdin so it never reaches shell history:

```sh
printf '%s' "$FEISHU_APP_SECRET" | lark-cli profile add --name dori --app-id "$FEISHU_APP_ID" --app-secret-stdin
lark-cli --profile dori auth status   # bot identity: ready
```

The profile holds the tenant token; the app secret is never written to this repository. `~/.dori/config.json` names the profile under `feishu.profile`. The bot needs the IM message scopes (send, reply, edit, receive events) and `im.message.receive_v1` enabled in long-connection mode. Put the owner's open_id under this app in `feishu.ownerId`; `dori inbound feishu` drops everyone else. `feishu.chatId` optionally pins one chat. If lark-cli prints a console-precheck warning about `application:application:self_manage`, it only means it cannot read the app metadata; the IM long connection still works.

## 2b. Other messengers (optional)

Install agent-messenger (github.com/agent-messenger/agent-messenger) and read which platforms it supports. Ask the owner which one to use and wait for the answer.

agent-messenger wraps part of each platform. Read the platform's current bot API changelog and call the API directly for the rest:

- Telegram: stream a reply as it grows and show "Thinking…" with message drafts, send rich messages for tables and headings, and use topics in the private chat (turn on threaded mode in BotFather's mini app; there is no API for that switch).
- Discord: edit your own messages to grow them, and use threads (`dori thread start --to <channel> --message <id> --name "[working] …"`). Receiving is `dori inbound discord`: create the bot in the Developer Portal, enable **Message Content Intent**, invite it with Read Message History, Send Messages and Create Public Threads, then set `DORI_DISCORD_TOKEN` and `DORI_DISCORD_OWNER_ID` (optionally `DORI_DISCORD_CHANNEL_ID`).

### If the owner picks Slack: user token or bot token

Ask which mode, give the trade-off as a short list, and wait for the choice:

- **User token**: the Dori acts as a real member of the workspace.
  - It needs a paid seat, which the owner pays for.
  - It reads everything that member can see.
  - It can keep a green online dot (`dori presence slack`).
- **Bot token**: the Dori is a Slack app.
  - There's no seat cost.
  - It only sees channels it is invited to, within the scopes the app was granted.
  - It shows as an app, not a person.

Record the choice. With a user token, set `DORI_SLACK_TOKEN` and `DORI_SLACK_COOKIE` (the `d` cookie from that member's browser session). With a bot token, set `DORI_SLACK_TOKEN` to the `xoxb-` token. If you run a second Dori home on the same machine, also write that home's token to `slack-token` next to its `config.json` (`chmod 600`): `dori launch` then hands its lanes the file's path, never the token (see `dori launch` in `scripts.md`).

## 3. Bot (Feishu in this fork)

Create the bot in the Feishu developer console and set its avatar there. Send it one DM from the owner account, run `dori inbound feishu --loop 1`, and confirm one `INBOUND` line. Then greet the owner with `dori send feishu --to <chat_id> --text "..."`.

The same step for other platforms (optional). Finish every login in the browser. Create the bot with agent-messenger and finish its setup. Then give it its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Telegram**: @BotFather → `/setuserpic` → pick the bot → send the image.
- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon.
- **Slack**:
  - bot token: the app's **Basic Information** → Display Information → App icon;
  - user token: the member's profile photo (`users.setPhoto`, or the profile page).

Greet the owner through the bot before doing anything else.

## 4. Scripts

```sh
cd skills/dori-mode/scripts && bun install && bun link    # puts `dori` on PATH
mkdir -p ~/.dori && cp ../references/config.example.json ~/.dori/config.json
```

Then edit `~/.dori/config.json`: at least `runtime` (`"herdr"` or `"hc"`), `leadPane` (your own session: `herdr pane current` on herdr, `echo $HC_TERMINAL_ID` on hc; `DORI_LEAD_PANE`, `HERDR_PANE_ID` and `HC_TERMINAL_ID` are picked up automatically), `laneWorkspace` (may stay empty so lanes open as tabs in the lead's workspace), `defaultCwd`, `feishu` (profile, ownerId, optional chatId) and `git` (repos whitelist, baseBranch, mergeMode, testCommand). `references/scripts.md` explains every field.

## 5. Monitors

Arm these as persistent monitors in your own session:

| Monitor | Command | Filter |
|---|---|---|
| inbound messages | your messenger's watch command | new owner messages |
| Feishu inbound (this fork) | `dori inbound feishu --loop 1` | `^INBOUND` |
| Discord inbound (this fork) | `DORI_DISCORD_TOKEN=… dori inbound discord --loop 1` | `^INBOUND` |
| done flow | `dori watch` | `^LANE_` |
| dead panes | `dori dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE)` |
| host guard | `dori guard --loop 1` | `^HOST_GUARD` |
| freshness | `dori freshness --loop 5` | `^(NUDGED\|POSTED\|NO-REPORT\|PENDING-REPORT\|STALE-REPORT\|STALLED\|JOURNAL-ERROR\|WORKING-WHILE-PAUSED)` |
| Slack inbound (Slack only) | `dori inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `DORI_TELEGRAM_TOKEN=… DORI_TELEGRAM_OWNER_ID=… dori inbound telegram --loop 1` | `^INBOUND` |
| presence (optional) | `dori presence slack` or `dori presence discord` | `^PRESENCE_READY` |

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.
