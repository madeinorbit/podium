# Attachment lifecycle: what exists, what is missing, what it should be

*Written for POD-1761 after the operator asked how native reattach works today, and
what a simple, robust design would look like. Everything in "what exists" is read
from the code at `fbccf39ea` with file and line; everything in "what it should be"
is a proposal.*

> ## CORRECTION — 2026-08-25, after this was written
>
> **I claimed opencode warm-parks and only codex cold-starts. That is false, and
> POD-2761's drive disproved it by measurement.** Both cold-start on every view
> switch: process tables captured across Chat→CLI→Chat→CLI show nothing alive
> between generations for either harness.
>
> The reason is one line. The release arm calls `clientTerminals.close()` for
> **every** server-family session and only varies the `kind` argument — and
> `close()` reclaims `record.label` whatever `kind` says, because `kind` is
> consulted only when there is **no** record. On a release straight after an
> attach there is always a record. **So the warm window, the `watched` flag and
> the whole arm/park machinery never apply to a view switch at all.** They are
> dead code for the case they were written for.
>
> That makes §2.2 and §2.4 below **worse than described**, not better: I wrote
> that retention is one constant and one panic button. In fact the constant never
> fires on the path that matters. It also means the fix is **harness-agnostic** —
> §3.2's `parkable` capability is still worth having, but no driver is parkable
> today, so nothing can be fixed by declaring codex the exception.
>
> The proposal in §3 survives; the diagnosis in §2 was half right, and the wrong
> half was the half that decides the fix. Details and the measured tables are in
> `docs/evidence/pod-2761/README.md`.

> ## CURRENT STATUS — 2026-08-29
>
> The old measurement remains valid as pre-fix evidence, but it is no longer the
> current implementation description. OpenCode now declares `parkOnRelease` and
> parks its abduco master when the viewer returns to Chat; the next Native attach
> adopts that master and keeps its scrollback. The shared attach seam also emits a
> clear/reset sequence only for a newly created client generation, so Codex and
> Grok's deliberate cold starts cannot paint a fresh interface into old scrollback.
>
> Codex and Grok remain non-parkable because their native clients own direct
> writers that must be revoked on release. The explicit `parkable`/`revokeOnRelease`
> capability pair and a recency-based retention policy are still proposal work;
> no provider runtime drive has yet promoted the continuity rows at the current tip.

---

## 1. The question

A **client terminal** is the harness's own TUI — `opencode attach`, `codex resume
--remote`, `grok --resume` — running *beside* a server-family session so a human can
look at the native interface. It is a convenience the user opened; the session is the
work.

The lifecycle question is: **how long should one live after the human stops looking at
it?** Too short and every switch is a cold start. Too long and idle TUIs hold memory
on a box that has fallen over five times this week.

The operator names four signals that should feed that decision:

1. the session is visible right now, in either view
2. the session is visible right now **in native**
3. recency of the session being visible at all
4. recency of the session being visible **in native**

— and adds a fifth axis that is not a signal but a constraint: **how many** sessions
are in a given recency band.

---

## 2. What exists today

### 2.1 One signal, not four

The only input is `sessionPriority.nativeView` — signal **(2)**, as a boolean.

It is aggregated from the live clients' visible mode and reaches the daemon on the
`sessionPriority` frame (`control/session.ts:1829`). Two things happen on it:

```
ctx.clientTerminals?.viewers(msg.sessionId, nativeView)   // retention input
nativeView ? requests.add(id) : requests.delete(id)        // existence input
reconcileNativeClientTerminal(ctx, id)
```

**Signals (1), (3) and (4) do not exist.** The daemon cannot distinguish "this session
is on screen in Chat" from "this session is not on screen at all" — both are
`nativeView: false`. There is no timestamp of last-visible anywhere; the only clock is
a single per-attachment timer.

`opencode-attach.ts:50-55` is explicit that the *subscription*, not the session's
visibility, is the signal — deliberately, so Chat keeping a session open does not keep
its sibling TUI hot. That is a defensible choice, but it means the product has thrown
away the information needed to answer "was this the session you were just looking at?"

### 2.2 Retention is one timer and one flag

Per attachment: a `watched` boolean and a **30-minute** idle window
(`WARM_TTL_MS`, `opencode-attach.ts:99`), armed when `watched` goes false, cancelled
when it goes true. Configurable only through a port, deliberately — *"a setting nobody
sets is a setting nobody maintains."*

Under host pressure the server sends `reclaimAttachments`, which calls
`reclaimUnwatched()` (`opencode-attach.ts:566`): it closes **every** unwatched
attachment. Not the oldest, not the *N* oldest — all of them.

So the answer to *"by recency, and also by count"* is: **neither exists.** There is one
threshold (30 minutes) and one panic button (close everything unwatched). A session
you left ten seconds ago and one you left an hour ago are treated identically by the
sweep.

### 2.3 There is an interface, and it is the wrong shape

`OpencodeClientTerminals` (`opencode-attach.ts:180-205`) is genuinely a shared
interface — `viewers()`, `close()`, `reclaimUnwatched()`, `reclaimable()` — and the
daemon holds exactly one of them. Two problems:

**It is named for a driver.** `OpencodeClientTerminals` serves codex and grok too. A
name is cosmetic; what follows is not.

**The shared layer branches on driver identity.** In the release arm
(`control/session.ts:282`):

```ts
await ctx.clientTerminals?.close(
  sessionId,
  handle.binding.driver === 'codex-app-server' ? 'codex' : undefined,
)
```

The policy layer asks *which driver is this* and hard-codes the answer. That is this
epic's most-repeated defect — **an assertion on an identifier rather than on the thing
it addresses** — appearing in the architecture rather than in a test. Codex needs
different teardown because its stock TUI **owns a direct WebSocket to the codex Unix
listener**, so releasing the lease must revoke that writer or queued keystrokes bypass
the daemon's lease gate (`control/session.ts:278-281`). That is a real, driver-specific
*capability difference*. It is expressed as a driver *name check* in shared code.

### 2.4 The consequence the operator hit

Because of that branch, **codex does not warm-park at all**. The comment says it
plainly: *"The next Native view starts a fresh client."* So:

- **opencode**: switch away, master parks, switch back, reconnect — cheap, continuous.
- **codex**: switch away, client destroyed, switch back, cold start — no history, and
  the fresh TUI repaints the whole interface into a scrollback that still holds the
  previous paint. Both symptoms the operator saw fall out of this.

Is that a driver bug? **No — it is a missing layer.** Every individual decision is
defensible. What is missing is anywhere that says *"a cold start must not look like a
continuation"*, because no layer owns the user-visible consequence of a teardown
choice made for lease-safety reasons.

---

## 3. What it should be

### 3.1 One policy object, four signals in, one verb out

Introduce an **attachment retention policy** that is the only thing allowed to decide
*when*, sitting above every driver:

```
in:   per session — visibleNow: 'native' | 'other' | 'none'
                    lastVisibleAt: timestamp
                    lastNativeAt:  timestamp
      per host  —   attachments alive, memory headroom
out:  keep | park | close   (per attachment, on every evaluation)
```

That is the operator's four signals, made explicit, plus the count constraint. The
policy is **pure** — inputs to a decision, no I/O — so it is testable without a daemon,
a browser or a harness, which today it is not.

Concretely it replaces one threshold with a small ladder:

- rendering native → **keep**
- left native, session still on screen → **park**, short window (it is the session
  they are working in; a switch back is likely)
- session not on screen → **park**, long window
- over the attachment budget → close the **least recently native** first, not
  everything unwatched

Recency then does real work, and count does the work `reclaimUnwatched` currently does
with a hammer.

### 3.2 Drivers declare capability; nothing branches on their name

Replace `driver === 'codex-app-server'` with a declaration on the driver:

```ts
interface ClientTerminalCapability {
  /** Can a parked client be resumed, or must the next view start fresh? */
  parkable: boolean
  /** Teardown must revoke an out-of-band writer before the lease is released. */
  revokeOnRelease: boolean
}
```

codex declares `{ parkable: false, revokeOnRelease: true }` — the same behaviour it has
today, but as a *fact about codex* stated where codex is defined, rather than a
condition in shared control flow. The policy layer reads capability and never learns a
driver's name. Adding a driver becomes a declaration, not an edit to a branch that
nobody will remember exists.

This also makes the consequence *visible*: `parkable: false` is a thing a reader can
see and ask about, which is what nobody could do with a `===` buried in a release arm.

> ### LANDED — POD-2823
>
> The direction shipped; the two field names in the sketch above did not, and the
> reason is worth more than the fields would have been.
>
> **What shipped.** `ServerRuntimeSpec.clientTerminal` — a `Declared<T>` on the
> harness's own manifest carrying a `labelToken` and a `launch()`. The daemon's
> attach path (`apps/daemon/src/runtime/opencode-attach.ts`) now looks the harness
> up and never compares it to anything. Nine `harness-branching` violations in that
> file went to zero with no new violation anywhere.
>
> **The nine were four questions.** Which durable label a parked client holds; what
> to run to reopen this conversation; whether an engine address rides on argv;
> whether per-session server credentials ride in the env. The last three are all
> `launch()`, and the address/secret split is not a new axis at all — it is
> `transport`, which the spec already declared. Two branches wanting one property
> is the finding this file predicted.
>
> **The fifth was already declared, twice, differently.** The strip-list branch
> picked between three constants by name and then unioned the result with
> `harnessChildStripEnv(kind)`, which reads exactly the same fact off the manifest.
> For opencode and grok the two sides were the identical array. For codex they were
> not: `STRIPPED_CODEX_CREDENTIALS` carried six variables and
> `codex.inventory.foreignCredentialEnv` carried three, so every codex spawn that
> read the manifest — the PTY path, the login probes — had been leaving
> `OPENAI_ORGANIZATION`, `OPENAI_ORG_ID` and `OPENAI_BASE_URL` in the child's
> environment while the app-server path stripped them. The union in the attach path
> had been quietly papering over that for both. The manifest is now the only home
> and the constant reads it.
>
> **`parkable` and `revokeOnRelease` were NOT added, on purpose.** The correction
> at the top of this file establishes that no driver parks today, and the release
> arm closes every client terminal unconditionally for the very reason codex gave
> it. Declaring either would have produced a field no code reads — the same defect
> as a name check, relocated somewhere more flattering. §3.3's obligation still
> wants `parkable`; it should arrive with the code that honours it.
>
> **The archetype in §2.3 is gone too.** `close(sessionId, driver === 'codex-app-server' ? 'codex' : undefined)`
> was already inert — `close()` reclaims the record's own label whatever kind it is
> given, and on a release straight after an attach there is always a record — so
> the argument only ever narrowed the no-record probe, which is not something the
> teardown obligation wants narrowed. It now passes no kind, and the probe asks
> every harness that declares a client terminal. The test that guarded it had the
> same defect: it asserted `close(SESSION, 'codex')` while believing it asserted a
> teardown. It now asserts the order that actually protects the lease gate — client
> down, then lease released — for every server driver.

### 3.3 A non-parkable driver owes the user an honest cold start

The moment `parkable: false` is written down, an obligation follows: **a cold start
must not look like a continuation.** One of —

- replay the conversation it is resuming, or
- clear the scrollback it is about to duplicate, or
- say plainly that this is a fresh view

— is required of any non-parkable driver, and testable from the declaration. Today
nothing requires it because nothing names the condition.

### 3.4 What I would not change

The lease revoke on release is **correct** and should not be traded away for
convenience: the stock TUI holds a direct writer, and leaving it warm would let
keystrokes bypass the lease gate. The fix for the operator's symptoms is not "park
codex too". It is to stop hiding, in a name check, the fact that codex cannot park —
and then to owe the user something better when it cannot.

Similarly the choice that the *subscription* is the signal rather than session
visibility (§2.1) is sound as a default. The proposal does not reverse it; it adds the
other three signals so a policy can distinguish cases the current boolean flattens.

---

## 4. Summary judgement

| Question | Answer |
| --- | --- |
| Is there a unified interface across drivers? | Partly. One object, one set of verbs — but shared code branches on driver **name**, so the abstraction leaks at the one place it matters. |
| Are these driver bugs? | No. Each driver's behaviour is individually defensible. |
| Is the product decision layer well placed? | **No — it does not exist.** Retention is one constant and one panic sweep, living inside a file named for one driver. |
| What is the smallest honest fix? | Name the capability instead of the driver; put the four signals into one pure policy; require a non-parkable driver to make its cold start legible. |

The through-line is the same one this epic keeps finding: **a property that holds by
accident rather than by declaration.** Codex's teardown is right for a reason nobody
wrote down where a reader would look, so its user-visible cost went unnoticed until
someone drove it.
