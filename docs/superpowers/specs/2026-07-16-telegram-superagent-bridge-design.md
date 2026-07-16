# Telegram superagent bridge — V1 design (spec SP-5d81, issue #583)

## Goal

Talk to the Podium superagent from messaging apps, starting with Telegram, riding
the existing notification integration (bot token + private chat already configured
under Settings → Notifications). Multi-app from day one via an adapter seam.

## Architecture

New server module `apps/server/src/modules/messaging/`:

- **`types.ts`** — the seam. `ChannelAdapter` (start/stop/send/sendTyping) is all a
  platform implements; `ConversationRef` (`channel`, `chatId`, `threadRef?`) is the
  normalized conversation address (hermes-style: apps differ — bot DMs, channels,
  threads, forum topics — so the sub-conversation id is first-class from the start).
- **`telegram.ts`** — `TelegramChannel`: long-polls `getUpdates` (50s timeout) on the
  notification bot. Authorization = the configured chat id; every other chat is
  ignored. Skips the update backlog on start (no replays after redeploys). Outbound
  is plain text chunked at 4000 UTF-16 units with ` (n/m)` counters, one inline retry
  on flood control. Pauses while the settings telegram-setup pairing window is open
  (concurrent `getUpdates` consumers 409).
- **`service.ts`** — `MessagingService`: maps a conversation to a superagent thread
  (`resolveThreadId` — V1: everything → the `global` orchestrator thread), keeps a
  per-thread FIFO of inbound messages, dispatches them via `superagent.sendTurn`,
  and relays replies back. If a web-dispatched turn holds the thread, the message
  stays queued and retries when that turn ends. Typing indicator while awaiting.

Reply plumbing: new bus event **`superagent.turnEnded`** `{threadId, podiumSessionId,
ok, output?, error?}` emitted in `SuperagentService.finishPendingTurn` — the daemon
already returned the final assistant text (`result.output`); it was previously
dropped. Fired for every turn regardless of dispatcher, so the bridge can both relay
its own replies and use foreign turn-ends as "thread is free" signals.

## Notifications folding

Unchanged: `pushTelegram` keeps posting attention notices into the same chat.
The bridge owns only the conversational lane. Unifying notification delivery
through the adapter (formatting, topic routing) is follow-up work.

## Deliberate V1 limits (follow-ups tracked as issues)

- Plain text replies (MarkdownV2 + rich formatting next).
- No slash commands.
- One chat ↔ global thread; forum-topic ↔ per-session/issue thread mapping next
  (Bot API 9.3 topics in private chats).
- Messages arriving while the server is down are skipped (backlog skip on start).
- Text messages only (no media/edits/reactions).
