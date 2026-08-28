# POD-1761 release milestones

*Rewritten 2026-08-25 after operator feedback. The first draft cut releases by
harness (flip one driver at a time, keep the rest on the old path). That was
wrong: keeping harnesses on the old drivers means fully testing paths we intend
to throw away — double work, no benefit. This version cuts by **capability**:
what must be rock-solid, what only has to be no worse than today, and what
doesn't exist today and therefore isn't v1's problem.*

Companion documents: `docs/architecture/driver-capability-catalog.md` is the full
inventory of everything a driver can do (the long-term ledger). This document is
the release route through it. Plain language throughout, on purpose.

## Ground rules

1. **All three new drivers ship in v1** (codex, grok, opencode). They are already
   the default on this branch; un-flipping them would create work, not save it.
   **Claude headless is first-class / high-priority** (operator ruling 2026-08-28):
   the persistent Agent SDK path may use the managed subscription credential under
   an explicit rollout acknowledgement, and PTY is the fallback, not the exclusive
   path. Do not skip Claude SDK cells as "terminal-only" or "no new testing
   burden." Canonical text: `docs/architecture/claude-subscription-oauth-policy.md`.
2. **The bar is set per capability, relative to today.**
   - *Tier A (non-negotiable):* works today, used every hour. Any regression
     blocks release.
   - *Tier B (weak or broken today):* the bar is "not worse than today" — and
     today is bad, so shipping imperfect is fine. Improvements are their own
     small releases after v1.
   - *Tier C (doesn't exist today):* explicitly out of v1. Zero test burden.
3. **Old code paths may keep running** as long as they work; deleting them is a
   late milestone, never a rider on a feature.
4. **Every milestone releases.** Merge, deploy the test instance, drive the
   checklist by hand or script before calling it done. A milestone that is pure
   bug-fixing is a legitimate release — stability is a benefit.

## The capability tiers

### Tier A — non-negotiable (regression here blocks any release)

| # | capability, in plain words |
|---|---|
| A1 | A sent message arrives, or you are told why not. Never silently lost. A queued message shows as queued and survives a reload. |
| A2 | The status you see is true: working / idle / waiting for you. |
| A3 | Stop and interrupt work. |
| A4 | Permission prompts show up and can be answered — from chat where safe, always in the terminal. Answering twice is an error, not a double action. |
| A5 | The conversation renders in chat. |
| A6 | Both views work and switching is safe: the chat view and the native terminal view each function on every session that offers them, and switching between them — repeatedly, in both directions — never restarts, corrupts, or kills the session. |
| A7 | Restarts don't lose sessions: restart the background service or reboot, and the session comes back as the *same conversation* — never a blank session wearing the old name. |
| A8 | A logged-out harness gets a working login path. |
| A9 | Killing a session actually kills it, and dead helper processes don't pile up on the machine. |
| A10 | Hibernate (park) and wake work without wedging the session. |

### Tier B — weak, flaky or embarrassing today (ship at "not worse", improve after v1)

| # | capability | today's reality |
|---|---|---|
| B1 | Provider failure messages | chat says the bare words "provider error" (fixed for grok's quota case; others still vague) |
| B2 | Out-of-memory reporting | an OOM-killed session can look like it just finished |
| B3 | Mail delivery into a running session | held together by hook tricks; grok's version sacrifices a denied tool call |
| B5 | Cost / token usage display | mostly absent in the UI |
| B6 | Draft sync between devices and the terminal | flaky screen-scraping |
| B7 | An agent blocked on something invisible (login screens, setup dialogs) | often undetected — the session just sits there |
| B8 | Chat/terminal view switching cosmetics | scrollback glitches |

### Tier C — doesn't exist today (explicitly not in v1)

**Live streaming of replies into chat** (chat shows completed messages today —
token-by-token streaming to viewers does not exist for any harness), moving a
session between machines (import/export), switching model mid-session, session
forking, rewind/checkpoints, "send this when the turn ends", a machine-level
process inventory command. These stay in the capability catalogue as backlog;
no release below waits on them.

## Sorting the open bugs by tier

Initial sort — the coordinator confirms each call. **Tier A = v1 blocker.**

**Blocks v1 (Tier A violations):**
- POD-2470 — the web app doesn't load on this branch at all (blocks everything).
- POD-2116 — a live session accepts input and silently discards it (A1).
- POD-2775 — hibernating a codex session wedges it (A10).
- POD-2761 — switching to the terminal view restarts it and fakes continuity (A6).
- POD-2602 — terminal view mis-sized until manually resized (A6).
- POD-2691 — dead agent server processes survive for days (A9; the old path left
  no servers behind, so this is a regression).
- POD-2772 — the login gate wrongly blocks server drivers (A8).
- POD-2631 / POD-2692 — the machine forgets an installed harness / login readout
  wrong (A8: sessions can't start or show wrongly logged-out).
- POD-2432 — sessions must survive a daemon restart on all three drivers (A7);
  for codex and grok this means auto-resume, since their server child dies with
  the daemon while the old path survived.
- POD-2298 — a refused send must not stay displayed as delivered (A1).

**Does not block v1 (Tier B, or invisible to users):**
- POD-2604 / POD-2693 (error wording and design — B1), POD-2603 (undetected
  login dialogs — B7), POD-2293 / POD-2773 (streaming — B4), POD-2043 / POD-2026
  (mail mechanics — B3), POD-2030 (discarded exit info on a side path — B1),
  POD-2746 (message duplication analysis — triage first), plus all
  test/tooling/docs issues.

**Also not blocking:** everything filed against gates and infrastructure
(POD-2714, POD-2759, POD-2778, POD-2728, POD-2040, POD-2031…) — those belong to
M0 below, since without them we cannot *know* a release is safe.

## The milestones

### M0 — we can trust a release again

No behaviour changes. Two things only:
1. Land and verify the fixes already sitting in review — POD-2470 (web UI broke
   on an earlier tip; the fix exists on its branch), POD-2116, POD-2761,
   POD-2602, POD-2775, POD-2298 — each under merge-lock with its reviewer
   verdict, each then driven live.
2. The automated checks mean something: today several fail for reasons unrelated
   to this project (outdated test snapshots, a type-checker that misses folders
   or exhausts the machine, a "test" command that runs almost nothing). Fix
   those so that **green = safe to ship** (POD-2714, POD-2759, POD-2778,
   POD-2728, POD-2040, POD-2031).

Exit: checks green; test instance runs this branch; one message sent and
answered on each of claude, codex, grok, opencode, and a shell session.

### M1 = v1 — the new drivers release, Tier A verified

Work through the Tier-A blocker list above. Then the release test is the tier
table itself: **every A-row driven live on every shipped driver** (a written
drive script per row, so re-verification is cheap next time), and spot-checks
that Tier B is not worse than today. Claude headless (`claude-sdk`) is a shipped
driver for that table, first-class with the others; `claude-pty` remains the
fallback. Shell sessions driven unchanged.

User benefit: codex, grok and opencode sessions on plumbing that tells the
truth — receipts instead of hope, real status, survivable restarts — with
nothing users rely on today lost.

### M2 — truth upgrades (Tier B, part 1)

Small, independent releases; order by pain:
- Provider failures named in chat everywhere, and "errored" visible as a state
  (B1, B2 — POD-2604 pattern, POD-2693).
- Blocked-but-invisible sessions detected and surfaced (B7 — POD-2603, and the
  POD-2414 work that turns failures into answerable prompt cards).
- Mail into sessions without the hook tricks, on the new-driver path (B3).

### M3 — streaming (the first Tier C capability)

Replies stream live into chat for all three drivers, including the first turn a
viewer joins (POD-2293, POD-2773). Strictly new — no harness streams into chat
today — which is exactly why it is a milestone of its own after v1 rather than
a v1 requirement. First in the Tier C queue because it is the most visible.

### M4 — new capabilities (Tier C, pick by demand)

Cross-machine session handoff (import/export), machine process inventory,
mid-session model switching — each its own release, each pulled from the
capability catalogue when someone actually needs it.

### M5 — deletion

Retire the old code paths the new drivers replaced (the old headless subsystem,
raw terminal injection, the second streaming plane): each marked absorbed /
deliberately dropped / still needed, and the absorbed ones deleted. This is the
milestone where maintenance cost actually drops. The epic's fleet-scale
acceptance (50 agents, one week, nothing stuck, no collateral OOM kills) closes
the epic here.
