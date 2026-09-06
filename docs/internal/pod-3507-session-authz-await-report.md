# POD-3507 — session authz read a promise as data

Branch `issue/3507-session-authz-reads-a-promise-as-data`, cut from `722d5568f`.

## What the brief asked for, and what was actually there

The brief named **four** sites in `session-authz.ts`. Patching those four would have
been wrong, and the reason is the whole point of this issue: the four were a *sample*,
surfaced by a runtime stack trace. The thing that made them invisible was never the
code at those lines — it was the **port**. `SessionAuthzPorts` was:

```ts
export interface SessionAuthzPorts {
  clientControl: any; deps: any; listSessions: any
  sessionById: any; machines: any; sessions: any; store: any
}
```

`store: any` is why the async flip produced no compile error anywhere in this file,
and why a pre-existing `as GrantRow[]` cast at two sites looked like ordinary
tidiness rather than the load-bearing lie it had become.

So the first commit on this branch changes **no behaviour at all**: it spells the
ports with the signatures the store actually has (spec rule 56 — *widen the port
first, then let the compiler name the sites*). The compiler then named **seven**
sites in `session-authz.ts`, not four.

### The three the brief did not have

All three are `live ?? this.ports.store.sessions.getSession(id)`. An `any` on the
**left** of `??` makes the whole expression `any`, so even a correctly-typed store
could not have caught them:

| Line | Method | Effect when unawaited |
|---|---|---|
| 267 | `machineUseForClient` | `session.machineId` is `undefined` on the promise — a machine-use decision taken against a machine that does not exist |
| 332 | `sessionOwner` | promise is truthy, `issueId`/`ownerUserId` are `undefined` → **"this session has no owner"**, silently |
| 374 | `primeOwnerMemo` | same, for every session in a full-list pass |

Two of those are the *silent* failure mode the brief flagged as the dangerous one —
and there were three of them, not one.

## The cascade

`sessionOwner` is the single definition of "who owns this session". Making it async
propagated through the entire session-visibility path — the gate that decides which
sessions a person can see:

`SessionAuthz.sessionOwner` → `SessionState.canReadSession` → `SessionView.project`
→ every session list, pin list, tab order, snooze list and draft replay.

Three sites in that cascade were **invisible to `tsc`**, because TS2801 only fires on
a bare promise in a condition — never on `!promise`, `.filter(p)` or a floating call:

- `view.ts:239` — `.filter((s) => canReadSession(...))`. A pending promise is truthy,
  so the filter keeps **every element**: at this exact site that projects every
  session in the fleet to every reader.
- `view.ts:189` — `if (!canReadSession(...))` — `!promise` is always `false`.
- `view.ts:211` — `primeOwnerMemo?.(...)` floating.

Plus eight more of the same three shapes inside `session-state/service.ts`
(`listPins`, `listTabOrders`, `setTabOrder`, `markRead`, `markUnread`, `setSnooze`,
`clearSnooze`, `readOverlay`), each found by reading, not by the compiler.

## Derivation, not sampling

The brief asked for the *class*. Two mechanical sweeps over `apps/server/src`:

1. **A cast applied to a store call** — the signature of this bug.
   Found `session-meta-ops.ts:434`:
   `loadDeletedSessionsForIssue(issueId) as SessionRow[]` then `.map(...)` on it →
   `rows.map is not a function` on **every issue restore**. Fixed here.
2. **Port declarations whose supplier is async** (POD-3374's third class, spec rule 56).
   Widening `listSessions()` named **two** crash sites, not the one reported:
   `session-revival.ts:241` (the handoff coordinator, as reported) **and**
   `handoff/transfer.ts:178`, which computes `occupiedWorktreePaths` — the
   server-authoritative guard against resetting a shared workspace.

## Evidence

**Typecheck.** `apps/server` `tsgo --noEmit` clean, whole package, tests included.
It was clean before too — that is the point of the issue.

**Mutation check — the load-bearing one.** Ten awaits added to `session-authz.ts`,
each removed one at a time *by line* (not by pattern), each edit verified as a
1-line diff, test re-run each time. **10/10 killed, every one with an isolating
reason:**

| Line | Site | Reason the test gave |
|---|---|---|
| 267 | `machineUseForClient: getSession` | `expected 'denied' to be 'granted'` / `'denied' to be 'absent'` |
| 332 | `sessionOwner: getSession` | `expected undefined to be 'u_issue_owner'` |
| 341 | `sessionOwner: memoIssueOwner` | `expected Promise{…} to be 'u_issue_owner'` |
| 344 | `sessionOwner: memoGrantees` | `expected Promise{…} to deeply equal [ 'u_grantee' ]` |
| 374 | `primeOwnerMemo: getSession` | `expected undefined to deeply equal { id: 'iss_x', … }` |
| 390 | `primeOwnerMemo: getIssues` | **`TypeError: found.get is not a function`** |
| 396 | `primeOwnerMemo: listForResources` | **`TypeError: found.get is not a function`** |
| 407 | `memoIssueOwner: getIssue (no memo)` | **`expected 'u_session_fallback' to be 'u_issue_owner'`** |
| 409 | `memoIssueOwner: getIssue (memo set)` | **`expected 'u_session_fallback' to be 'u_issue_owner'`** |
| 420 | `memoGrantees: listForResource` | **`TypeError: edges.filter is not a function`** |

Rows 390/396/420 reproduce, on demand, the exact two runtime errors POD-3374
measured. Rows 407/409 are the important ones: they are the **silent** site, and the
test catches it *by naming the owner it expected*. A test asserting "no error was
raised" passes on the broken version — which is why the fixture is built so
`u_issue_owner` (right) is never equal to `u_session_fallback` (the plausible wrong
answer an unawaited issue read falls back to).

**Regression A/B.** Control arm built by `git checkout <base> -- apps/server/src`
plus removing the new test file (no stash — the stack is shared), verified
byte-identical to base with an empty `git diff --stat` before each run.

- `src/modules/sessions` + `src/modules/superagent`, both arms: failing-test-name
  sets **identical**, 75 lines, `comm` empty in both directions. 410 tests executed
  identically; +6 are the new file.
- `rename-offline.test.ts` + `rename-shadow.test.ts` fail on **both** arms
  identically (26 failed / 9 passed, all 20s timeouts) — pre-existing, not this change.
- The four files that directly cover the changed authz code, under the correct
  runner and shard config: **4 files, 26 tests, all pass, 11.3s.**

`PODIUM_TEST_WORKERS=1` was set in this environment for every run above.

## What I could NOT measure, and why

**POD-3374's headline number (38 of 205 boundary failures) is not reproduced here,
and I am not claiming it.** Two honest reasons:

1. My first attempt ran the boundary lane with the **node** vitest binary. 107 of its
   120 files died at import with `Only URLs with a scheme in: file, data, and node
   are supported… Received protocol 'bun:'` — they never executed. Both arms read
   "0 occurrences" of both error signatures, which looks exactly like a fix and is
   not one. The lane needs `bun --bun`.
2. Under the correct runner the lane is prohibitively slow in this worktree (>9 min
   for 20 files) and a heavy gate needs the `test:heavy` lease, which was held by
   another session (issue #3359) throughout. I queued for it once and cancelled the
   slot rather than leave an orphan.

A treatment-only run showing zero occurrences would prove nothing without the paired
control, so it is left undone rather than reported as green.

## Filed, not fixed

- **POD-3509** — client attach ordering. `onClientAttached` is now async, but
  `ClientMux.attachClient` cannot become async: `wireClientSocket` needs its returned
  id synchronously to register `ws.on('message')`/`ws.on('close')`. Marked
  `// DECISION POD-3509` and converted in the most literal form (voided in place, same
  statement position). Note the premise is already broken independently:
  `ClientMuxDeps.bootstrap` is declared `=> void` and `relay.ts:3231` supplies an
  `async` function — spec rule 56, pre-existing.
- **POD-3511** — the offer path. `SessionMetaOpsPorts.store` is `store: any`, hiding
  three more: `clearOffer`'s guard can never fire, `dismissOffer` **always returns
  false** for a session not in memory, and issue-restore installs sessions with a
  promise where the offer map belongs. That last one sits inside a post-commit
  `apply()` closure, which the landing freeze covers, so I did not touch it.

## Note for whoever lands this

`apps/server/test-shards.json` is regenerated, not hand-edited — the new test file was
in no shard, and a file the manifest does not name runs nowhere while the lane still
reports green. A second `bun scripts/server-test-shards.ts --write` produces no
further diff.
