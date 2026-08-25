# POD-2753 — independent adversarial review, round 4 (final)

Reviewer: session POD-2753-B, own detached worktree at `/home/mgw/rev-2753`.
Reviewed at **`fd4f17e5a`** (the author's branch tip). No product code changed.

## Read this before the findings: what I could and could not measure

The host ran at **load 74–98** for this entire round, with **1.0–1.3 GB available** — below
the 1.5 GB floor I was given. One `vitest` run of the isolation test took **4m05s wall for
3.1s of CPU**; an earlier one exceeded ten minutes. None of that is the test's fault and I am
not reporting it as one — it is a starved host, and my own processes were not the cause.

**So I did not run the full suite at this tip, and nothing below claims I did.** Instead I
extracted the guard's own functions — `requirerViolations`, `requirerLoads`, `LITERAL_CALL`,
`literalOf`, `REQUIRER_ALLOWANCE` — **verbatim** from `claude-sdk-isolation.test.ts` and drove
them directly, using the test's own `caught()` predicate copied from line 546.

That is not a weaker check for these shapes, and here is why: the suite's verdict on a shape
is a **pure function of exactly three routes** — `extractImports`, `LITERAL_CALL`, and
`requirerLoads`/`requirerViolations`. I exercised all three for every shape below and
confirmed all three are silent. The one thing I did not verify by execution is the
overall red/green of the suite at this tip.

## Verdict

**The fixes to rounds 1–3 are real. I checked each one and they are done properly, not
papered over.** But the ban's central claim — that it closes the *class* rather than the
instances — does not hold, and the allowance list re-opens the arms race the ban was written
to end. Two of the three new findings are in the allowance mechanism, which is exactly where
POD-1761 predicted the new soft spot would be.

**14/14 is accurate and I verified the count myself** — the CI table has 14 entries
(S0, S0b, S0c, A0, A0b, A1, A2, A2b, A3, A4, A5, A6, A7, A8). But every one of them either
obtains the capability *through the banned token* or is a plain literal, and none is evaluated
in an **allowed** file. 14/14 measures the battery I supplied, not the class the ban claims.

---

## New findings, severity-ordered

### R1. HIGH — the allowance list re-opens the arms race, inside the five allowed files

The ban's argument for refusing to chase parking tricks is that you cannot hide a capability
you were never allowed to obtain. In an allowed file you **are** allowed to obtain it — and
every parking trick works again on the pinning check.

Driven through the guard's own functions, in `apps/daemon/src/claude-sdk-protocol.ts`
(allowance: `['tsx']`):

| shape | ban | graph edge | result |
| --- | --- | --- | --- |
| G3 `const r = createRequire(…); r('<sdk>')` — plainly | fires | — | **RED**, correctly pinned |
| G1 `let r; r = createRequire(…); r('<sdk>')` — assignment, no declarator | silent | none | **GREEN** |
| G4 `const io = { r: createRequire(…) }; io.r('<sdk>')` — property | silent | none | **GREEN** |
| G5 `const [r] = [createRequire(…)]` — destructured | silent | none | **GREEN** |
| G6 `function mk(){ return createRequire(…) }; mk()('<sdk>')` — returned | silent | none | **GREEN** |

`requirerLoads` captures a requirer only from `(?:const|let|var)\s+NAME\s*=\s*…createRequire\(`.
G1's `r = createRequire(…)` has no declarator; G4/G5/G6 have no direct binding. No specifier is
collected, so nothing is compared against the allowance and no edge is created.

**Failure scenario.** `claude-sdk-protocol.ts` is legitimately allowed a loader for `tsx`. One
line parks that loader on a property and loads the SDK instead. The pinning check compares
nothing, the graph gains no edge, the ban does not fire — and the SDK is in the daemon's heap
with the suite green. These are the *same shapes* (A3, A4) the ban exists to avoid chasing;
they were closed at the front door and left open behind the allowance.

### R2. HIGH — an allowed file can lend the capability out, and the borrower is invisible

The premise is "the capability has to be obtained before it can be hidden". An allowed file
obtains it legally, and can hand it to anyone:

```ts
// packages/pty/src/backends/node-pty-backend.ts   — ALLOWED ['node-pty']
const req = createRequire(import.meta.url)
export const lentReq = req                          // legal: this file may hold it

// any daemon module — no createRequire token anywhere in it
import { lentReq } from '@podium/pty/backends/node-pty-backend'
const m = lentReq('@anthropic-ai/claude-agent-sdk')
```

Measured: ban silent, `requirerLoads` empty, no graph edge — **GREEN**.

The borrower has no token to ban and no binding for `requirerLoads` to find. The CI table's
**A7** is exactly "requirer exported across a module boundary" and it is RED — but only
because its exporting file is *not* allowed. From an allowed file the identical shape is
green, so A7 does not cover the one configuration where the export is legal.

**Failure scenario.** Any of the five allowed files grows an `export` of its requirer — a
plausible refactor when two backends want one loader — and the ban is bypassed repo-wide by
files that never mention `createRequire`.

### R3. MEDIUM-HIGH — the fourteenth shape: the ban names one door, not the class

`createRequire` is not the only way to obtain require-like capability. All silent on all three
routes:

| shape | realism |
| --- | --- |
| F1 `Module._load('<sdk>', null, false)` | a real Node API, used in the wild |
| F6 `Module.prototype.require.call(module, '<sdk>')` | real |
| F3 `new Function('return require')()('<sdk>')` | a widely-used bundler-dodge idiom |

I also confirmed F2 (`nm['create'+'Require']`) and F4 (`process.getBuiltinModule('module')`
with a computed property) defeat it, but those are string-split obfuscation and I am **not**
resting this finding on them — a guard is not obliged to stop someone spelling around it
deliberately. F1, F3 and F6 are things people write for ordinary reasons.

The claim "banning the token bans every spelling of every shape at once" is true for shapes
that obtain the capability *through that token*. It is a **stronger and much better** guard
than following the requirer — the reasoning in the commit is right — but it is a ban on one
door, and the class has more than one.

**Suggested shape of a fix for all three:** ban the *result*, not the acquisition — treat any
call of a locally-bound function with a bare module-specifier-looking string literal in a
daemon file as a violation unless allowed. Failing that, at minimum: add `Module._load`,
`Module.prototype.require` and `new Function` to the banned tokens; capture requirers from
assignments, properties, destructuring and returns; and forbid an allowed file from
`export`ing its requirer.

---

## Round 1–3 findings: all fixed, and fixed properly

| # | finding | status |
| --- | --- | --- |
| 1 | `drive-verify.sh` check 4 vacuous | **Deleted**, not papered over — and the measured zeros are recorded in the script so the next person sees *why* it was vacuous. Replaced by running the isolation walk against the commit the processes were started from. This is the honest fix. |
| 2 | compiled pin was a spelling check | **Fixed.** `COMPILED_ENTRY` is a graph root; only the direct, sentinel-guarded dynamic edge is dropped, so my one-hop `sdk-preload.ts` re-export is now followed. |
| 3 | timed-out turn reported success | **Fixed.** `claude-sdk-client.ts:137` — `if (timedOut) fail('turn timed out')` now guards the `done` branch. |
| 4 | from-source entry points unpinned | **Fixed, and derived rather than listed** — three properties: calls `startDaemon`, references the daemon module, or is a worker entry. |
| 5 | host did not wind down on stdin EOF | **Fixed.** `claude-sdk-host.ts:168-180` — EOF now calls `interrupt()` when a turn is in flight. |
| 6/7/8 | fail-open walker, unreachable commit, inverted name | addressed |

The evidence script now carries its **own** vacuity control (S0/S0b/S0c), **reconciles its
coverage against the CI table** and fails on a mismatch, and checks the tree is clean
afterwards. That closes POD-1761's item 4: the two forms can no longer rot independently.

Special credit where it is due: `fd4f17e5a` records that the harness "ran twelve shapes and
read as thirteen" — the evidence for the fix had the defect the fix was about. Writing that
down instead of quietly adding the two missing shapes is the single most trustworthy thing in
this change.

## Two process notes

- **The branch is split.** Integration `issue/1761-agent-runtime` is at `4fac02b5a`;
  `fd4f17e5a` (the harness-coverage fix) is on the author's branch only. I reviewed the
  author's tip. Land the last commit before closing.
- **`badd8a9c3` is not "a live re-drive."** It is `fix(daemon): stop exporting helpers from
  the isolation test`, and it is *older* than `fbccf39ea`, not newer. Worth correcting in
  whatever record cites it.

## Recommendation

**R1 and R2 should be fixed before this lands** — both are in the allowance mechanism, both
put the SDK in the daemon's heap with a green suite, and both are one ordinary line of
refactoring away. R3 is worth closing but is a smaller step: the ban is a genuine improvement
over following the requirer even as it stands.

Everything else in this change is now good. The move is faithful, the roots are derived, the
controls are real, and the evidence rig documents its own past failures rather than hiding
them. The remaining gap is not in the idea — it is that the allowance list, which the ban
needed in order to be adoptable, was given a weaker check than the ban itself.
