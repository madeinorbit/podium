# A chat send that stays pending forever, held by the draft it came from

Investigated off `main` at `c9708e5ac`, against the live instance on
`vmi3431366`. Reported symptom: *"a message stayed pending with claude; it only
started once i fired a message in native view."*

**The fix has since landed on this issue's branch** — see
[What shipped](#what-shipped) at the end, including the one bullet of the
proposed fix that turned out to be wrong and was dropped.

The message was not lost and the agent was not stuck. The server **deliberately
held** the message, because it believed the operator was still mid-sentence in
that session's composer — and it believed that because the composer's
clear-on-submit had been **rejected** by the new versioned-draft arbitration and
can never be accepted again on that device.

## The headline

`sessions.sendText` (the transcript composer's send) rides the unified message
delivery path, and that path holds a message when the target session has a
non-empty composer draft:

```ts
// apps/server/src/modules/messages/service.ts:1018
if (this.draftHoldActive(target)) {
  return { ok: true, queued: true, disposition: 'queued' }
}
```

```ts
// apps/server/src/modules/messages/service.ts:1301
private draftHoldActive(target: SessionMeta): boolean {
  return target.draftUpdatedAt !== undefined
}
```

The hold is POD-865's protection against injecting mail into a half-typed line.
It fires *before* the state machine that would otherwise deliver the text
(`stateOf` → idle → inject, or `status === 'starting'` → the durable boot queue,
lines 1022–1041), so a held message never reaches either.

Pressing Enter in the chat composer does two things, over two different
transports:

```ts
// apps/web/src/features/chat/use-chat-surface.ts:483
setDraft('')          // draft edit, over the WEBSOCKET
…
void send.send(text)  // sessions.sendText, over HTTP
```

If the draft never actually clears on the server, the send that follows it is
held — and nothing ever un-holds it, because the only drain triggers are a turn
boundary (`session.stateChanged` → phase idle) and the slow sweep, and both
re-check the same hold. The sweep keeps the row `queued`; the idle drain is
worse — it reports the rows as **handled while delivering none of them**:

```ts
// apps/server/src/modules/messages/service.ts:567-583
const handled = messages.map((message) => message.id)
if (this.draftHoldActive(session)) return handled
```

The composer, meanwhile, looks empty: `setDraft('')` updates the local store
synchronously. The operator sees a cleared box and a bubble that says the
message is waiting its turn. Typing in the native view bypasses all of this —
those keystrokes go straight to the PTY — which is exactly the workaround that
was observed to "start" the agent.

## Why the draft never clears

Since 2026-08-14 every draft edit — not just the flagged Draft Sync v2 path — is
arbitrated by revision:

- `881435740` *feat(server): version every draft; keep only native inject behind
  the flag* made `applyVersionedEdit` unconditional. Before it, a flag-off
  instance took the legacy last-writer-wins path where a clear that reached the
  server **always** landed.
- `5520877b2` *feat(client-core): rev-aware local draft ledger* gave the browser
  a `serverRev` per session, sent as `baseRev` on every edit.

The arbitration rejects an edit whose `baseRev` does not match the document's
`rev`, unless the sender still holds the ~1.5s soft lease
(`packages/model/src/entities/draft-doc.ts:117-120`). And the client's ledger
**only ever moves its `serverRev` forward**:

```ts
// packages/client-core/src/drafts/draft-ledger.ts:137-140
const nextRev =
  incoming.rev !== undefined && incoming.rev > (local?.serverRev ?? 0)
    ? incoming.rev
    : (local?.serverRev ?? 0)
```

So if the server's `rev` ever goes **backwards** relative to what a client has
already adopted, that client is wedged permanently: every edit it sends carries a
`baseRev` above the document's, the lease is long lapsed, so the server rejects
it and answers with its own (lower) rev — which the ledger refuses to adopt. It
resends the same losing `baseRev` forever. The clear-on-submit is one of those
edits.

### And the server's rev does go backwards

The document's persistence is debounced, and **the timer is reset by every
keystroke**:

```ts
// apps/server/src/modules/sessions/session-state/service.ts:600-614
private persistDraftDoc(sessionId: SessionId, doc: DraftDoc): void {
  const existing = this.draftDocWriteTimers.get(sessionId)
  if (existing) clearTimeout(existing)   // ← starved by continuous typing
  …
  const timer = setTimeout(…, DRAFT_WRITE_DEBOUNCE_MS /* 750 */)
```

During a typing burst nothing is written at all, while every accepted rev is
broadcast to the clients. Anything that re-hydrates from the store then rolls the
document back to the last persisted rev:

- a server restart (`relay.ts:1086` → `loadFromStore()`), and
- `restoreDeletedForIssue` at runtime (`session-meta-ops.ts:416` →
  `loadFromStore()`), with no restart at all.

`loadFromStore()` (service.ts:186-208) rebuilds `draftDocs` from
`session_drafts`, and `installSession` (service.ts:211-215) re-applies
`draftUpdatedAt` from the same row — so a stale non-empty draft survives every
restart and keeps holding sends indefinitely.

## What the live instance shows

Session `ed13f9bc` (POD-1201's agent), `claude-code`, `live`:

| time (UTC) | fact |
| --- | --- |
| 13:47:27 | session spawned, no input yet |
| 13:48:15.940 | last draft edit the server ever accepted — `rev 29`, `origin c0` |
| ~13:48:19–13:48:23 | server restart: `502`s + `socket closed — reconnecting` in `~/.podium/logs/clients/web.ndjson` |
| 13:48:52.296 | `msg_d1cc8b36` created, `urgency=next-turn`, `lifecycle=wait`, **`status=queued`** — never delivered |
| 13:53:24 | operator types in native view; agent goes `working`; the stuck message is **retracted** (`message.cancelled`) |
| 14:14 (and now) | `podium agent status ed13f9bc` still reports `state: … draft=yes` |

The decisive evidence is the *content* of the surviving draft row. The server's
document is a strictly older prefix-with-a-hole of the message that was sent:

```
session_drafts.text  (rev 29, 13:48:15.940Z)
  "new agent in project button" in the sidebar AND  should have the same greying
  out for unsupported agents like the + drop down in the tab area;

messages.body        (13:48:52.296Z)
  "new agent in project button" in the sidebar AND "add agent" in the flight deck
  should have the same greying out for unsupported agents like the + drop down in
  the tab area;

  also, the + drop down in the tab area: remove the resume part
```

Everything the operator typed after 13:48:15.940 — the `"add agent" in the
flight deck` insertion at the `AND ` cursor, and the whole second paragraph —
plus the clear that Enter performed, was refused by the server. The socket was up
for that whole window (the once-a-minute `issues.setTucked` retries in the same
log get HTTP `500`, not `502`, so the server was answering), and an accepted
clear deletes the row outright (`store/sessions.ts:917-919`). The row's continued
existence at `rev 29` is only consistent with *nothing after rev 29 was ever
accepted*.

The same fingerprint appears on 2026-08-14, the morning `881435740` landed:
session `5eed4b7b` has a draft `"Fire a rebuild please"` stamped `08:31:10`,
while the identical message was sent at `08:23:29`. The draft was written *after*
its own send.

## Positive control

The deadlock reproduces deterministically at the seam, driving the real server
arbitration (`applyDraftEdit`) against the real client ledger
(`createDraftLedger`) — script in the [appendix](#appendix-the-repro-script):

```
type: baseRev=0 -> applied; serverDoc(rev=1, text="a"); clientRev=1
type: baseRev=1 -> applied; serverDoc(rev=2, text="ab"); clientRev=2
type: baseRev=2 -> applied; serverDoc(rev=3, text="abc"); clientRev=3
                       ← the restart rolls the doc back to rev 2; the client holds rev 3
clear (submit): baseRev=3 -> REJECTED; serverDoc(rev=2, text="ab"); clientRev=3
resend #1: baseRev=3 -> REJECTED; serverDoc(rev=2, text="ab"); clientRev=3
resend #2: baseRev=3 -> REJECTED; serverDoc(rev=2, text="ab"); clientRev=3
resend #3: baseRev=3 -> REJECTED; serverDoc(rev=2, text="ab"); clientRev=3
resend #4: baseRev=3 -> REJECTED; serverDoc(rev=2, text="ab"); clientRev=3
draftHoldActive = true
```

The client never converges, because it will not take a rev below the one it
holds. Note the shape: the *text* it is shouting is the empty string — the
composer's clear.

## The fix, in three parts

1. **The deadlock breaker (client).** `adoptRemote` must resync to a rev the
   sequencer names even when it is *lower* than the one held — a rollback is a
   real event, and the server is the authority on its own position. Keep the
   dirty text (that rule is right), take the rev unconditionally. Cost when the
   frame was merely out of order: one extra round trip, which the next rejection
   corrects.

2. **Stop rolling back (server).** `persistDraftDoc` must not let continuous
   typing starve the write — a fixed-window flush (don't reset a pending timer)
   bounds the loss to one debounce interval instead of a whole burst.

3. **The hold must not be able to deadlock a send (server).** Two problems, both
   in `messages/service.ts`:
   - With `draft-sync` **off** — the shipped default, and this instance's state —
     a client-composer draft is never typed into the PTY
     (`scheduleDraftInject` is gated at service.ts:584), so the agent's prompt
     line is empty and there is nothing for an injection to corrupt. Holding on
     it protects nothing while risking exactly this deadlock. Gate the hold on
     the draft actually being able to reach the prompt line (`draft-sync`
     enabled, or `origin === 'native'`).
   - `drainPreferred` (service.ts:574) returns held rows as `handled` without
     delivering them; a hold should leave the rows for the next pass, not consume
     the pass. **(Wrong — see [What shipped](#what-shipped).)**

A fourth, cheap safety net worth considering: an operator send whose text
*equals* the session's current draft is that draft's submission — clearing the
document instead of holding behind it would make the common case
self-correcting.

### Immediate remedy for a wedged session

Reload the web app. The ledger's snapshot omits empty text, so on boot the tab
has no entry for that session, adopts the server's document as authoritative, and
repaints the stale text into the composer at the server's rev. Editing or
clearing it *from that state* is accepted, `draftUpdatedAt` clears, and the
`oplog.appended` → `onSessionEligibilityChanged` path drains anything still held.

## What shipped

Three changes, each with a test that was run against the OLD code first and seen
to fail.

**1. The client takes the rev the sequencer names, in either direction**
(`packages/client-core/src/drafts/draft-ledger.ts`). `adoptRemote` no longer keeps
only the highest rev it has seen. The reasoning it replaces — "a lower rev is an
out-of-order frame" — does not hold: frames for one session arrive over one
ordered socket, so a lower rev is the server saying it moved back. The dirty-text
rule is untouched; only the rev is adopted, which is what lets a resend land.
Test: `a server whose rev rolled back › converges: the rejected clear is re-sent
on the base the server named` (and the old assertion, "ignores a rev that moves
backwards", is now its opposite, with the reason written where the old rule was).

**2. The draft write is a fixed window, not a per-keystroke debounce**
(`apps/server/src/modules/sessions/session-state/service.ts`). `persistDraftDoc`
no longer restarts its timer on every edit, so a burst persists every ~750 ms
instead of nothing at all, and a re-hydration can be at most one window behind
what the clients were told. A clear still writes immediately and now also closes
any open window, so a stale non-empty row cannot outlive the submit that cleared
it. Tests: `the draft write window › persists mid-burst instead of waiting for the
typist to pause`, and `… › writes a clear immediately, even with a window already
open` (in `relay.test.ts`).

**3. The hold applies only where a draft can reach the agent's input**
(`apps/server/src/modules/messages/service.ts`). `draftHoldActive` now asks
`sessions.draftInjectionActive()` — the live `draft-sync` state, wired through
`SessionLifecycle` — because injection is the only thing that makes a draft and
the agent's prompt line the same text. With injection off (the shipped default)
a chat draft lives in the browser, there is no half-typed prompt line to corrupt,
and the guard has nothing to protect. Note the shape of what it was doing there:
the daemon's native scrape is behind the same flag (`handleNativeDraft` returns
early), so on a flag-off deployment the only draft the guard could ever see was
the browser one — the harmless signal — and the dangerous one, a person typing in
the native terminal view, was invisible to it either way. An unwired dependency
still holds: that is the conservative side for a guard whose job is not corrupting
someone's typing, and with (1) and (2) in place a hold now ends when the draft
clears. Tests: the
four cases under `composer-draft delivery guard [POD-865] › and whether the draft
can reach the agent at all [POD-1204]`; every pre-existing POD-865 hold test
passes untouched.

**Dropped: the `drainPreferred` bullet.** It was wrong. Returning held rows as
`handled` looks like the drain swallowing them, but `handled` is per-flush
bookkeeping only — no row state is written, and the rows are re-queued by the next
trigger. What it actually prevents is the same rows being re-attempted through
`attemptOne` in the same pass, and that path is not side-effect-free:
`prepareQueuedAttempt` clears `injected`, increments the echo-requeue count, and
at `MAX_ECHO_REQUEUES` marks an injected row `delivered`. Letting draft-held rows
fall through would have burned that budget and could have marked a message
delivered that never landed. The suppression is right as it stands.

Still open, deliberately: with `draft-sync` **on**, a rolled-back document is now
recoverable but the hold is still unbounded, so the fourth safety net above (a
send whose text is the draft submits it) remains worth doing. Recorded as deferred
work on the issue rather than folded in here.

## Noticed in passing (not this bug)

`issues.setTucked` has been failing with HTTP `500` and being retried by the
outbox once a minute for at least 45 minutes in `web.ndjson` — an outbox entry
that can never succeed and is never dropped. Worth its own issue.

## Appendix: the repro script

Save at the repo root and run `bun run <file>`. It imports the two modules by
source path so it never picks up a stale `dist/`. It holds no clock and no
sockets: the server half is `applyDraftEdit` exactly as `applyVersionedEdit`
calls it, the client half is the shipped ledger.

```ts
import { applyDraftEdit, emptyDraftDoc } from './packages/model/src/entities/draft-doc.ts'
import { createDraftLedger } from './packages/client-core/src/drafts/draft-ledger.ts'

const sid = 's1' as any
const ledger = createDraftLedger()

let doc = emptyDraftDoc(sid)
let t = Date.parse('2026-08-17T13:48:00.000Z')
const tick = (ms: number) => { t += ms }

function serverEdit(text: string, baseRev: number, origin: string) {
  const r = applyDraftEdit(doc, { baseRev, text, origin, at: new Date(t).toISOString() })
  if (r.status === 'rejected') return { rejected: true, doc: r.doc }
  doc = r.doc
  return { rejected: false, doc: r.doc }
}

// The client sends its dirty text, then adopts whatever came back — the two
// halves of the runtime's `sendDraftNow` / `on('sessionDraft')` pair.
function clientSend(label: string) {
  const local = ledger.get(sid)!
  if (!local.dirty) return
  const res = serverEdit(local.text, local.serverRev, 'c0')
  ledger.adoptRemote(sid, { text: res.doc.text, rev: res.doc.rev })
  console.log(
    `${label}: baseRev=${local.serverRev} -> ${res.rejected ? 'REJECTED' : 'applied'}; ` +
      `serverDoc(rev=${doc.rev}, text=${JSON.stringify(doc.text)}); ` +
      `clientRev=${ledger.get(sid)!.serverRev}`,
  )
}

for (const text of ['a', 'ab', 'abc']) {
  ledger.localEdit(sid, text, t)
  clientSend('type')
  tick(400)
}

// The restart: reload the DEBOUNCED row, which never saw the last accepted rev.
doc = { ...doc, text: 'ab', rev: 2, editedAt: new Date(t - 800).toISOString() }

tick(3000)          // the person pauses, then presses Enter
ledger.localEdit(sid, '', t)
clientSend('clear (submit)')
for (let i = 1; i <= 4; i++) { tick(600); clientSend(`resend #${i}`) }

console.log(`draftHoldActive = ${doc.text !== ''}`)
```
