# POD-4778 — What an agent is told when its message was not delivered

Status: design note for approval, 2026-09-29. Read on `issue/4720-acknowledged-message-delivery-chain`
at `21143f09b`. Part of POD-4720 (§2 agent-sent row, §4 rule 1 "notices use a deterministic id").

## 1. The answer

An agent that sent a message acts on the belief that the recipient has it: it waits for a
report, or it moves on because it thinks the instructions landed. The one thing a failure notice
is for is **correcting that belief**, and pointing to the single next step that can still help.
So:

- **Push** a notice to the sending agent when its message **ended without being delivered, and
  the sender did not choose that ending**: `failed`, for any cause. Exactly one notice per
  message, at its next turn.
- **Do not push** anything for a message that is still on its way or whose fate is unknown.
  `unknown` is not an ending (a later machine report still moves it), and the only thing an agent
  could do with it — resend — is the one thing it must not do. It is shown on request
  (`podium mail status`), where it already says "check before resending".
- **Do not push** endings the sender chose or already knows: `expired` (the sender set the time
  limit), `cancelled` (withdrawn), a failure returned by the send call itself (the CLI already
  exits with the reason), a notice that itself fails (system sender — no notice loop).
- **The system never re-addresses or resends on its own.** The sender picked that recipient; a
  different recipient needs different authority (issue sends may wake or spawn) and the text may
  be stale by then. The notice names the alternative instead.
- **The spawn prompt is a message like any other.** `podium agent spawn --prompt` gets a message
  id, the parent can check it with `mail status`, and a failure reaches the **parent agent**, not
  only the human.
- **The human is told only what a human can act on**: the target is waiting on a person
  (`never-live`), or the message was the human's own. Agent-to-agent failures stop raising
  attention for the target's owner.

## 2. Per outcome

"Target's issue" = the issue the target session was on (for an issue-addressed message: the issue
itself). The notice text is `Your message <id> to <target> was not delivered: <reason>. <action>`.

| Ending (status / cause) | Pushed to sending agent? | Reason + the one action in the notice | Human attention? |
|---|---|---|---|
| `failed`, target session gone / archived | yes | "that session has ended." → if its issue is open: "Send to POD-N (`podium issue mail send N …`) to reach whoever works it now." Else: "Nobody else holds that conversation; do not wait for a reply." | no |
| `failed` `teardown` (session stopped before it was typed) | yes | "the session was stopped before it was typed; it never saw it." → same issue re-address line as above | no |
| `failed`, issue closed / archived / deleted | yes | "POD-N is finished." → "Do not wait for a reply." | no |
| `failed`, authority lost (apply-time re-authorization, wake placement refused) | yes | "you are no longer allowed to reach it." → "Do not resend; do not wait for a reply." | no (a human removed the authority) |
| `failed` `never-live` (target not accepting input — waiting on a person, or never started) | yes | "the target is waiting on a person and was not accepting input; it was never typed, and its owner has been told." → "Sending it again later is safe; nothing is waiting in its queue." | **yes**, target's owner (only a person can unblock the target) |
| `failed` `delivery-failed` (machine refused or failed the hand-off; never typed since POD-4775) | yes | "the target's machine could not hand it over; it was never typed." → "Sending it again is safe." | no |
| `failed`, spawn prompt (any cause above) | yes, to the **parent** (spawner) session | as the matching row above, plus "the child session <id> has no task." → "Send the task with `podium session send <id>` or stop it." | only if the spawner was a human |
| `unknown` | **no** (pull only) | `mail status`: "handed on, but it cannot be told whether it arrived — check before resending" (exists) | yes if the sender was a human (exists: "Input delivery unconfirmed") |
| `unknown` → later `failed` | yes, then (the `failed` row applies) | as above | as above |
| `expired`, `cancelled`, send-time refusal, self-send | no | — | no |
| `confirmed` | no (a sender that needs an answer uses `--expect-response`) | — | no |

Where the notice goes: the sending session if it still exists; otherwise the sender's issue
(reaches whoever works it now); otherwise nobody (a system/steward sender, or nothing left to
reach). This is today's `replyTarget` rule, resolved when the notice is written.

How it arrives: a steward message, `kind: notification`, `urgency: next-turn`, `lifecycle: wait`.
A live idle sender (the usual "waiting for a report" state) gets it as its next turn; a parked
sender sees it when it resumes. It does not wake a parked session: a parked agent is not waiting
on anything.

## 3. Options considered and rejected

- **Automatic re-address to the issue.** Changes who receives the message and under what
  authority (an issue send may resurrect or spawn a session the sender never asked for). The
  sender often addressed a session on purpose (a reply to one conversation). Named in the notice
  instead — one command for the agent.
- **Automatic resend of never-typed failures.** A `never-live` target is waiting on a person and
  would refuse again; a `delivery-failed` hand-off may fail the same way. Retrying is the
  daemon's business inside one delivery (POD-4777), not a second message.
- **Pushing `unknown`.** Not an ending, and the only available reaction (resend) is harmful. The
  target's human already gets the unconfirmed attention when a human sent it.
- **Only-on-request for everything.** Today's shape; agents do not poll, so a coordinator waits
  forever on a child that never got its instructions.

## 4. How it is made reliable

Today there are four places that send the notice after the status write, each with a random id,
errors swallowed (`service.ts` `deadLetter` / `notifyDeadLetter`, the abandonment loop, the refused
receipt, and `notifyQueuedInputRejected` behind the in-memory `message.deadLettered` bus event —
reactions registry `messages.dead-letter-nudge`, `durability: 'in-memory'`, `replay: none`). A
crash between the write and the send loses the notice; a failed send is dropped silently.

Replace all four with one rule in the store: **the move to `failed` and the insert of its notice
are one write.**

- `MessageStore` failure moves (`markDeadLetter`, `markDeliveryAbandoned`, `markSendRefused`)
  take the prepared notice and insert it in the same `committed.write` as the guarded status
  update, only when the update moved the row. The notice id is deterministic: `ntf_<message id>`
  (the message is failed at most once, so one notice per message by construction; a repeat of
  the move changes nothing and inserts nothing).
- The notice row is an ordinary `stored` message. It is then delivered by the normal durable path
  (`messages.eligibility`, startup reconcile), so a server restart after the write delivers it,
  and it is never delivered twice (one id end to end, POD-4763).
- The service builds the notice (target, reason, action) **before** the move from the message
  row, the session and issue rows — reads only, no send.
- Deleted: `notifyDeadLetter`, its four call sites, the `message.deadLettered` bus event and its
  listener in `relay.ts`, the `messages.dead-letter-nudge` reaction entry.
- The spawn prompt: `session-start` creates a message row (from the spawner, to the new session,
  id `msg_<session id>_prompt`, returned by `agent spawn`) before queueing the initial prompt, and
  the inbox's initial-prompt row carries it as `sourceMessageId`. Its outcome then settles the
  ledger through the existing `authorization.applied / rejected / unconfirmed` hooks, and its
  failure takes the same notice path. `spawnedBy` names the parent, which is the sender.
- Human attention (`inbox.ts` → `attention.promptFailed`) fires only when the sender is a human,
  or the cause is `never-live`. A refused agent-sent row is never written into the target's
  composer draft (that would put an agent's text in a person's box as if to send it themselves).

## 5. CLI

- `mail send`, `issue mail send`, `session send`, `agent spawn --prompt`: the answer says what
  happened and that the sender does not need to poll:
  `sent msg_… (queued for the target's next turn; if it cannot be delivered you will be told at
  your next turn — 'podium mail status msg_…' shows where it is)`.
  Drop the POD-854 "blocking send" wording and the `delivered` / `accepted` labels no current
  server returns for these paths (keep a plain fallback for an older server).
- `mail status` / `show` / `inbox`: every line keys off `deliveryStatus` (the forward-only status),
  with its reason (`deliveryDeferredReason` or the target-gone reason) and, when a notice was
  written, `notified=ntf_…`. `inbox` today still keys the cause off the legacy `dead_letter` word.

## 6. Tests (each proven armed)

Server integration, real store, one per pushed outcome — target gone, teardown, issue closed,
authority lost, `never-live`, `delivery-failed`, spawn prompt → parent: the sending agent has
exactly one notice row, with the expected reason and action; restart the service between the move
and delivery (and again after delivery): still exactly one notice, delivered once. Negative ones:
`unknown`, `expired`, `cancelled`, human sender → no agent notice. Human attention: fires for
`never-live` and for a human sender, not for an agent-to-agent `delivery-failed`. CLI unit tests
for the new wording. Armed: remove the notice insert from the move → the restart test goes red;
insert unconditionally → the "exactly one" test goes red.

## 7. Files and sequencing

Needs `apps/server/src/store/messages.ts`, `apps/server/src/modules/messages/{service,queued-apply}.ts`,
`apps/server/src/modules/sessions/{inbox,session-start}.ts`, `apps/server/src/relay.ts`,
`apps/server/src/composition/reactions.ts`, `apps/cli/src/{mail-cli,session-cli}.ts` plus the
spawn CLI. The first four are POD-4774's live files: start only after POD-4774 lands and this note
is approved; the coordinator is asked for those files in the same mail.

Observed, not in scope here: a refused row written back into the target's draft for a **human**
sender is the draft restore §4 of POD-4720 wants deleted; that belongs with the chat surface
(POD-4764), not here.
