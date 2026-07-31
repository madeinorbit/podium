# POD-1239 — the attribution gate acquires a caller, and the count acquires a refusing arm

Status: the engine/replica half is LANDED on `issue/1239-bug-attribution-gate-has-no-caller`
(4b06bb44). The counting half is a patch to a file owned by another live branch — §3
below is the patch, and it is recorded here rather than only in a mailbox because this
issue exists precisely so that a fix living in three mailboxes does not evaporate.

---

## 1. What was actually wrong, restated so the fix can be graded against it

POD-307 specifies the client's persisted store as **fail-closed**: a store that cannot be
attributed to the current principal is DISCARDED and re-bootstrapped, never adopted. On a
shared device that is the rule stopping one person's cached rows becoming another person's
history.

POD-377 built the gate (`packages/sync/src/adapters/legacy-replica/adoption.ts`). POD-378
verified it. POD-377 merged and closed on that basis. No client called it:

```
grep -rnE 'migrateLegacyReplica|decideLegacyAdoption|LegacyIdentityEvidence' \
  apps/web/src apps/mobile/src
(no matches)
```

Six sites build a client replica over persisted storage and none attributes it. Four are
owned by live siblings (POD-1223 web ×2, POD-1220 mobile, POD-378 deletes the TanStack
root). This issue owns the fifth — and the fifth is different in kind.

## 2. The fifth site is not a site

`packages/client-core/src/engine/engine.ts:297` read:

```ts
this.replica = init.createReplicaFn ? init.createReplicaFn() : createReplica()
```

and `createReplica()` with no argument resolved `window.localStorage` itself
(`replica.ts:463`).

**This is not a latent default.** `AppShell.tsx:135` passes `createReplicaFn` only when the
kernel-replica flag resolves to `kernel` or the Tauri SQLite factory resolved. A plain
browser with the flag off passes nothing — so the shipping web client took this path on
every boot and adopted whatever the previous person on the device left behind.

And it is the reason fixing the other five individually would still leave the system wrong.
Every audit of this property walks the set of **composition roots**: the places that
construct a replica. A replica the engine constructs *for itself* is in no such set. There
was no root to grade, no caller to add the gate to, and no finding to report — so the audit
reported the browser path clean by never having a wall to point at.

POD-1220 sharpened it from the mobile side and their point is the stronger one: on React
Native `window.localStorage` is not even the right object, so the fallback is *incoherent*,
not merely unsafe — a latent crash or a silent wrong-store adoption depending on the
polyfill. A default that cannot work on one of its two platforms is not a default.

### The three candidate fixes, and why one of them is wrong for a reason worth keeping

| | verdict |
|---|---|
| Make `storage` required on `ReplicaInit` | **No.** SQLite mode legitimately passes no storage — `desktopReplica.ts:135` constructs with `{ persisted }` only. A required `storage` breaks the most careful root. |
| Fail closed by DISCARDING when nothing is injected | **No.** On the flag-off web path that drops the queued outbox for real users on every boot until evidence is wired. Fail-closed is right for an *unattributable* store; it is not right for a store nobody has asked about yet. **A missing caller must not be converted into user data loss.** |
| Delete the implicit construction | **Yes.** Below. |

### What landed

- `EngineInit.createReplicaFn` is **required**; the `: createReplica()` fallback is gone,
  with a runtime throw behind the type (a type is erased, and the untyped caller is exactly
  the one that would reach ambient storage silently).
- `createReplica()` with no storage is now a **memory** replica — nothing adopted, nothing
  persisted, `persistent` false. The ambient reach is deleted, not defaulted.
- The browser's construction moves into the open as `apps/web/src/lib/webReplica.ts`, with
  the three formerly-implicit defaults stated (`storage`, cross-tab `storageEventApi`, the
  ui-state migration's `enumerateKeys`). Those were each keyed on `init.storage ===
  undefined`, so injecting a store silently also switched cross-tab sync off; behaviour is
  byte-identical, the coupling is gone.

**Cost side, named.** `createReplicaFn` was already passed by `MobileClientProvider.tsx:226`,
`kernelReplica.ts:149` and `engine.test.ts:217`. The only newly-obliged callers are the web
composition chain, where the value was already threaded — and `AppShell.tsx` needed **no
edit at all**, because it passes `undefined` on the flag-off path and a destructuring
default in `store.tsx` fires on `undefined`. One web test now passes a memory replica.

**One reach survives, deliberately.** SQLite mode's legacy-blob migration source: there
`storage` does not back the replica, it is the OLD blob store the one-time
localStorage→SQLite migration reads and retires. Deleting it would silently strip that
migration of its input. That read is itself unattributed — and it belongs to the persisted
roots, which are named composition roots the audit already grades, not to a default.

### `webReplica.ts` is deliberately UNATTRIBUTED

It does not call the gate. Wiring the browser's attribution is POD-1223's, and a competing
call here would collide with work in flight.

What changed is that the omission is now **countable**. Before, the browser path was clean
in the audit because there was no root to look at. Now it is a named composition root that
builds a persisted replica without asking — a finding: red today, green the day POD-1223's
attribution lands in it. *A hole that shows up in the count is a different object from a
hole that cannot.*

### Mutation evidence

Both instruments were driven to their refusing arm, one mutant at a time, each reverted and
grep-verified before the next.

| mutant | result |
|---|---|
| restore the ambient reach (`legacyMigrationStorage` returns `window.localStorage` unconditionally) | **2 of 3 cases RED** |
| disable the engine guard (`if (false)`) | **RED**, exactly the refusal case |

The ambient test was also red *before* the fix, on all three cases — including `writes`
showing the old code writing this user's rows into the previous user's localStorage.

`ambient-storage.test.ts` drives **both arms** by construction. The unattributed case first
proves the seeded store IS readable through the explicit seam, and only then asserts the
ambient reach misses it. Without that counterfactual an empty hydrate is indistinguishable
from an empty ambient store, and the test would pass against the unfixed replica — which is
the exact shape of evidence that let this defect through review the first time.

---

## 3. THE COUNTING HALF — a patch, and why it is a patch

`scripts/audit-phase2-client.ts` (POD-378) is already most of this instrument, and 61cabbbe
already fixed the part the brief warned about: discovery derives composition roots from the
tree instead of a hardcoded list of two, requires call shape so the files *declaring*
`createReplica` are not graded as roots, and the vacuous `COMPOSITION_ROOTS.length > 0`
guard is deleted. I am not rebuilding that.

It does not exist on this branch. It lives only on
`issue/378-2-3e-remove-tanstack-db-delete-tracking`; this branch forks from 67ce21b8.
Copying it here would put the same file on two branches for the coordinator to untangle,
which is the one thing the scope narrowing told me not to create.

### The hole that is left

```ts
const ASKS_WHO_OWNS_IT = /decideLegacyAdoption|migrateLegacyReplica|LegacyIdentityEvidence/
...
const attributed = ASKS_WHO_OWNS_IT.test(contents)
```

That is a **mention test over whole file contents**, and the gate's three names are exactly
the words a comment *explaining* the gate contains. A root carrying

```ts
// TODO: call migrateLegacyReplica here before we read anything
```

grades as attributed today.

This is the same mention-is-not-a-call shape 61cabbbe fixed on the *other* side of the same
function: call shape is required to be graded a **root**, but only a mention is required to
be graded **clean**. The strict half can be satisfied and the lenient half faked, and the
lenient half is the one that decides whether a security property is reported as held.

It cuts both ways: `BUILDS_A_REPLICA` is tested per raw line, so a *commented-out*
`createReplica(` also promotes an innocent file into the population. One change fixes both
directions, because both should read source with comments and strings removed.

### The patch

```ts
/**
 * The gate IN CALL POSITION, not by mention.
 *
 * The names of a gate are what a comment ABOUT the gate contains, so testing for the
 * name grades `// TODO: call migrateLegacyReplica` as attributed — a declaration with
 * no consumer, certified by the words describing the consumer it does not have.
 *
 * `LegacyIdentityEvidence` is deliberately NOT here. It is a type; a type mention is
 * not an act, and `import type { LegacyIdentityEvidence }` with no use is exactly the
 * shape that would pass. A root that genuinely produces evidence necessarily CALLS one
 * of the two functions to spend it.
 */
const CALLS_THE_GATE = /\b(?:decideLegacyAdoption|migrateLegacyReplica)\s*\(/

/**
 * Source with comments and string literals blanked.
 *
 * Both halves of this detector read it: a MENTION of the gate in a comment must not
 * grade a root clean, and a COMMENTED-OUT construction must not promote an innocent
 * file into the population. Blanking only ever removes text, so it cannot invent a
 * finding — a real call is never inside a comment or a string literal.
 */
function withoutCommentsOrStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}
```

and in `unattributedStoreRead`, read the blanked source for both tests:

```ts
    const source = withoutCommentsOrStrings(contents)
    const lines = source.split('\n')
    const constructs = (text: string) => BUILDS_A_REPLICA.test(text) && !IS_A_DEFINITION.test(text)
    if (!lines.some(constructs)) continue
    if (CALLS_THE_GATE.test(source)) continue
    out.push({
      file,
      line: lines.findIndex(constructs) + 1,
      text: 'builds a persisted client replica without establishing the store belongs to the current principal',
    })
```

`discoverCompositionRoots` should blank the same way, so the population and the grading
agree about what counts as source.

### Probe cases it needs (the arms that must fire)

1. A root whose only reference to the gate is a **comment** mentioning
   `migrateLegacyReplica` → **must be a finding**. This is the case that fails today, and
   it is the whole reason for the patch.
2. A root that actually **calls** `migrateLegacyReplica(...)` → must **not** be a finding.
   (The near miss for #1: without it the patch could be satisfied by flagging everything.)
3. A root with only `import type { LegacyIdentityEvidence }` and no call → **must be a
   finding**.
4. A file whose only `createReplica(` is **commented out** → must **not** enter the
   population.

### The patch was RUN before it was proposed

A patch nobody has executed is the same object this issue is about. Both graders — POD-378's
current one and the patched one — were extracted and driven against all five cases. The
before/after contrast is the evidence, not the after column alone:

| case | POD-378 today | patched |
|---|---|---|
| 1. only a **commented** mention of `migrateLegacyReplica` | clean ❌ | **finding** ✅ |
| 2. a real `migrateLegacyReplica(...)` call (near miss) | clean ✅ | clean ✅ |
| 3. only `import type { LegacyIdentityEvidence }`, no call | clean ❌ | **finding** ✅ |
| 4. a **commented-out** `createReplica(` | finding ❌ | not a root ✅ |
| 5. the file DECLARING `createReplica` (61cabbbe must not regress) | not a root ✅ | not a root ✅ |

Case 4 is a defect I did not set out to find: today a commented-out construction promotes an
innocent file *into* the population and reports it as an unattributed root. The mention
problem runs in both directions, and blanking comments once fixes both.

### The judgement I left open — RESOLVED by POD-1220, who writes the first caller

If a client wraps the gate in a helper and the root calls the helper, the stricter rule
reports that root unattributed. I declined to decide it alone. POD-1220's answer, as the
author of the repo's first real `migrateLegacyReplica` call:

> **NAME THE GATE AT THE ROOT.** Call `migrateLegacyReplica` in call position in the
> composition root and assemble the host object inline. I would choose that even without a
> grader requiring it, and the grader is the weaker of the two reasons.
>
> The stronger one is that this is the security-relevant call on the platform, and the
> question a reader arrives with is "does mobile attribute its store before adopting it?" —
> that question is asked OF the file that composes the store. A helper is better factoring
> for almost anything else and worse for this: it moves the answer one hop from where it is
> looked for, and one hop is enough for the next person to assume it does not happen.

With the caveat they attached, which belongs here so it does not get lost:

> I would not extend that to a general rule. "Inline it so the audit can see it" is a bad
> principle applied broadly — it shapes code around a detector. What justifies it here is
> that the root IS the right home for the call, and the detector happens to agree. **When
> those two come apart, fix the detector.**

So the patch needs no import-hop resolution: require the call at the root, because the root
is where the call belongs. And explicitly **not** by allowlist — an allowlist is where a
real one hides, which is that file's own stated principle.

---

## 4. What is still owed, and by whom

- **POD-1223** — attribution for `kernelReplica.ts`, `shadow/runner.ts`, and
  `apps/web/src/lib/webReplica.ts` (the root created here, deliberately red).
- **POD-1220** — mobile's caller; already in flight.
- **POD-378** — §3 patch, or their preferred variant of it.
- **This issue** — closes when the audit's unattributed-store item has a refusing arm that
  a commented mention cannot satisfy, and at least one real caller per client is counted by
  it.

Do not let "POD-377 verified it" appear in a handoff again without naming the caller.
