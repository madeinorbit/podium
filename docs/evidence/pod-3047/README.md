# POD-3047 — Claude SDK acceptance at the current epic tip

Written 2026-08-28 19:00 CEST. **Pin `ad02520c22a9cba42db7fc1dd8c44620f29f4509`** — all 27
readings, both arms, both credential postures, one named rig. Verified by script:
27 of 27 carry `serverSha = daemonSha = pinSha = ad02520c2`, zero mismatches, and
every pin records which posture produced it.

## Verdict

**15 PASS, 1 PARTIAL, 2 FAIL, 7 BLOCKED.** A3 passes with a negative control that
can fail. A5 passes. The two FAILs are the same finding — **A8 / B auth, and this
is the first valid reading this cell has ever had on the SDK path.**

## The two postures, and why both are needed

POD-3057 moved the SDK child into the instance agent home. That turned this rig's
credential posture from irrelevant into decisive, and it means **neither posture
alone can drive the whole column**:

| posture | what it is | what only it can measure |
|---|---|---|
| `symlink` | agent-home credential symlinked to the operator's existing one, on the coordinator's explicit authorisation. No copy, no mint, no rotation | everything needing a model reply — 22 rows |
| `absent` | no credential in the agent home | A8 and B auth, whose premise IS a logged-out session — 3 rows |

**Symlink, never copy, and the reason is not style.** A copy can go stale, and
presenting a superseded refresh token can be treated as replay and revoke the
whole family — logging the operator out of their own tool. A symlink cannot
diverge. `credential-check.py` reads `claudeAiOauth.expiresAt` against now,
refuses an expired credential, and never prints the value; it recorded 5h43m of
margin at bring-up. Both fences refuse a **regular file** at that path while
allowing the symlink, so the thing they always guarded — a copy this rig makes
itself — is still guarded.

**The live credential's mtime did not move across the symlinked drive:**
`2026-08-28 16:15:35 +0200`, size 962, identical before and after. The symlink
caused no rotation.

## A8 — the first valid reading of this cell

Every previous A8 on this path was vacuous: the SDK authenticated from the
operator home regardless of what the agent home held, so *"no login path was
offered"* was a statement about a session that had never been logged out. POD-3057
changed that.

At this pin, on the `absent` posture, the session is **genuinely logged out** —
the product says so itself, `Not logged in · Please run /login` — and the SDK
spawn offers **no login path**. That is a real, attributable FAIL.

**The control is the PTY arm on the identical rig, pin and posture, which DOES
show a login path.** So the rig can detect one when it exists; the SDK path
simply does not offer it. Without that arm this FAIL would be indistinguishable
from a probe that cannot see login paths at all.

## A3 — the cell this issue exists for

POD-3043 landed the repair but was forbidden a provider drive, so it recorded
PARTIAL and named the open clause: *transcript shows interrupt* —
**PROVEN PRODUCED, NOT PROVEN SURVIVING** … *the clause a live drive could still
falsify.* It survives.

| clause | reading |
|---|---|
| turn stops | YES, after `sessions.interrupt`, from an observed in-flight `working` |
| exactly one durable record | YES, one item, id `claude-sdk-interrupt-<sid>-1`, role `system` |
| what it says | `Turn interrupted by the operator.` — used **only** when the provider confirmed |
| **survives** | **YES** — present in a viewer opened after the first was dropped, and now also in `sessions.read`, which POD-3057 repaired |
| exactly-once under repeated presses | YES — two further presses left exactly one idle receipt, stop record untouched |
| refused interrupt says why | NOT EXERCISED live; the provider never refused |

**A3NEG** is what makes the wording clause capable of failing: `SIGSTOP` on the
host kills the ack on its 5s deadline and the same code writes the opposite
sentence. Frozen pids are `SIGCONT`-ed on every exit path.

## A1b — a PARTIAL, and the clause list is the finding

Sent while the session was **provably** `working` (phase sampled at the moment of
the send, not merely before it), the product answers
`{queued:false, position:1, disposition:"delivered"}` — and the reply does come
back after a reload.

So the clauses split. **The message is not lost**, which is what this cell exists
to protect, and a position is present. What is unmet is the self-description: it
reports itself *delivered*, `queued:false`, while carrying a queue position, for
a send made into a running turn. A bare FAIL would claim the message was lost; a
bare PASS would bless a disposition that contradicts itself.

## Four probes that a landing fix turned red

None of these was a product change, and all four are the same mistake: a probe
asserting on timing it had been getting for free from a reader that never worked.
Repairing `sessions.read` let `waitForNeedle` return the moment a reply is
persisted — **before the turn closes**.

| probe | what it did | what it does now |
|---|---|---|
| A5 | compared a snapshot to its own reload; the reload had *gained* the assistant reply | waits for the reply on the chat plane before snapshotting |
| A2a | read the phase the instant the needle appeared, caught it still `working` | waits for the turn to close — the criterion says *idle AFTER end* |
| A7b | hibernated mid-turn, got the correct refusal *"agent is working"*, scored it as lost context | waits for idle; a refusal the product explains is BLOCKED, not FAIL |
| A1b | assumed the busy condition still held at the send | samples the phase at the send; a condition that evaporated is BLOCKED |

And two that were wrong independently of any fix:

- **A4a/A4b counted a login prompt as a permission ask.** `interactions.list`
  returns every open interaction and a logged-out session raises `kind: 'login'`,
  so both cells reported *"permission ask appeared and answering resolved it"* —
  a PASS — on a session that never ran a tool and never wrote its marker. Keyed on
  `kind === 'permission'` now, with every other open kind counted and printed.
- **A1c killed a bystander.** It matched a transient `claude auth status` process
  and passed. Keyed on `claude-sdk-host`, the target set is empty: the SDK spawns
  its host per turn, so between turns there is nothing to kill.

**Every one of these produced a confident number rather than an error.** That is
the whole family this drive kept meeting, in its own instruments as often as in
anyone else's.

## Where the harness is, captured rather than inferred

Every reading now carries both halves of the question that cost this drive a pin:

- **the process half** — the live child's `HOME`, read from `/proc/<pid>/environ`
- **the disk half** — which home the session's JSONL landed under, using the
  product's own `claudeProjectSlug` so a misspelt directory cannot report a
  populated home as empty

At this pin the JSONL is under the **instance agent home** and `sessions.read`
returns the conversation — the inversion of what this drive measured before
POD-3057, and it is in the readings rather than in a paragraph.

## Results

`rows.tsv` carries 25 rows, tab-separated, validated at eight fields each, all
citing pin `ad02520c2`, each naming its posture in the `alone` column.
`docs/plans/pod-1761-results.tsv` and the release ledger are untouched.

| cell | claude-sdk | claude-pty |
|---|---|---|
| A1a | **PASS** | **PASS** |
| A1b | **PARTIAL** (not lost; disposition contradicts itself) | not driven |
| A1c | BLOCKED (no per-turn host to kill) | not driven |
| A2a | **PASS** | not driven |
| A2b | **PASS** | **PASS** |
| A3 | **PASS** | not driven |
| A3NEG | **PASS** (negative control fired) | not driven |
| A4a | BLOCKED (auto-approve; write landed) | not driven |
| A4b | BLOCKED (same) | not driven |
| A5 | **PASS** | not driven |
| A6a | BLOCKED — n/a on this driver | **PASS** |
| A6b | BLOCKED — n/a on this driver | not driven |
| A7a | **PASS** | not driven |
| A7b | **PASS** | not driven |
| A8 | **FAIL** (real condition; no login path) | BLOCKED (login path visible — the control) |
| A9 | **PASS** | not driven |
| A10 | **PASS** | **PASS** |
| B quota | **PASS** | BLOCKED (usage_limit) |
| B auth | **FAIL** (same as A8) | not driven |

## Limitations

- **The refused-interrupt clause of A3 has no live reading.** The provider never
  refused; POD-3043 covers it hermetically.
- **A8's after-login clause is unmeasured on both arms.** Completing external
  OAuth would rotate the operator's credential.
- **A1c has no reading in either direction** — its premise does not map onto a
  per-turn host process.
- **A4a/A4b remain the vendor-CLI auto-approve block**, now measured (the guarded
  write landed) rather than inferred from silence.
- **PTY B quota hit a genuine `usage_limit` late in the run.** It is a real quota
  condition on the account, not an auth one, and cells driven after it may be
  affected — the SDK cells all pre-date it.
- **Every row is `[single]`** — one arm, one pin, no A/B against main.
- **Two postures, and rows say which.** A row from one posture is not comparable
  to a row from the other on anything credential-dependent.

## Reproducing

```sh
P3047_CREDENTIAL=symlink bash docs/evidence/pod-3047/drive-up.sh   # 22 rows
P3047_CREDENTIAL=absent  bash docs/evidence/pod-3047/drive-up.sh   # A8 / B auth
bash docs/evidence/pod-3047/run-cell.sh A3    claude-sdk
bash docs/evidence/pod-3047/run-cell.sh A3NEG claude-sdk
bash docs/evidence/pod-3047/drive-down.sh
```

The pin is asserted before every cell, so a stale rig refuses rather than
producing a number. Superseded sets from earlier pins are quarantined in place
with a `QUARANTINE.md` each.
