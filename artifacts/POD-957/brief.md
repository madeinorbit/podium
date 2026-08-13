# Vacated origin experience

An issue whose session has rehomed is a signpost, not a review-ready empty task.

## The rule

If this task has no remaining session and the work continued elsewhere, it is a
signpost. The one action is “open the live tip.” Everything else is quiet.

A sessionless review with no continuation may still say the session ended.
A task that still has a session is a real task, even if it also spun work off.

## What is broken today

Opening POD-959 (archived, review, no sessions) after the agent hopscotched
POD-945-A → 959 → 962 → 963:

- Sidebar / explorer still treats it as needs-review because `stage === review`.
- Flight deck body is `Review ready · session ended`. The session did not end.
- Mission gauge reads `1 running · 0 agents`. The empty issue is the running unit.
- No “Left this mission” line. Departures drop finished children, and 963 is
  two hops away, so 959 points at nobody.
- Tab strip can keep the moved session as a leftover view (birth ref POD-945-A).

Continuation already exists for superseded / duplicate. Spinoff hopscotch never
writes those fields, so the signpost never appears.

## Surfaces

| Surface | Signpost does | Signpost does not |
| --- | --- | --- |
| Flight deck | Continuation card to the **live tip**. Open + Tuck. | “Review ready · session ended”, empty spine, “1 running · 0 agents” |
| Gauge / crew | Hidden, or an empty groove | Count the husk as a running task |
| Sidebar | Quiet row, continuation chip (`→ POD-963`) | Needs-review attention |
| Tabs | Empty, or follow the operator to the tip | Keep the rehomed session labeled POD-945-A |
| Issue explorer | Same card if opened after archive | Empty review-ready body |
| Archive | Operator’s choice | Auto-delete |

## Live tip

Follow outgoing `discovered-from` until the furthest issue that still has a
live session, else the furthest unfinished issue, else the last closed hop.

959 → 962 (done) → 963 (working) resolves to **POD-963**.
The operator does not walk the chain by hand.

## Two stories, one test

- Hopscotch (945 → 959 → 962 → 963): origin emptied, session moved. Signpost.
- True spin-off that still has its own session: keep the origin, show a
  departure tick to the child. Do not steal the remaining session’s tab.

Sessionless + living continuation = signpost.
Staffed + outgoing spin-off = real task with a departure.

## Worktrees

Today `attach --spinoff` only moves `session.issueId`. It does not take the
checkout. `start` on the new issue then `worktree add`s from `parentBranch`
(usually main). The session follows into the clean tree. The origin checkout
stays behind with whatever was uncommitted or unmerged.

That is the worst mix: the agent leaves, the work does not.

Confirmed: **be smart about the checkout.**

- Pending work (dirty files, or commits not on the parent branch): **take
  the worktree.** Re-key branch + checkout onto the new issue. Do not mint
  from main. The session never `cd`s.
- Done and merged into the parent (clean, `merged`, nothing ahead): **mint
  from main** for the new issue, and **release** the old checkout so it does
  not sit five commits behind forever.
- Origin never had a worktree: mint from main when work actually starts.
- True spin-off (origin still staffed): origin keeps its checkout. The child
  may mint from main.

POD-962 → POD-963 did not lose committed work — 962 was already on main —
but 962’s worktree is still on disk, five commits behind. That is the
merged-and-not-released case. POD-963 is dirty now; another hop under the
old rules would abandon that work.

## Lifecycle

Confirmed: **quiet signpost until the operator archives.**

Do not auto-close or auto-tuck. Comments and the diagnosis still belong on the
origin. Do not require agents to pick `supersede` vs `spinoff` correctly —
infer from membership + the discovered-from chain.

Tuck is offered on the card. Archive stays an operator gesture. Explorer may
still list an archived signpost; opening it still shows the card.

## Copy

- Card title: `Work continued in POD-963`
- Card body: `No session remains here. Dest web rebuild is in progress.`
- Primary: `Open POD-963`
- Secondary: `Tuck away`
- Presence, if a chip is needed: `Continued in POD-963` — never `session ended`
- Departure, when the origin is still staffed: `Left this mission` → live child

## Out of scope

- Renaming session display refs after rehome (POD-945-A on 963 can stay)
- Changing how agents decide to spin off
- Mobile-specific chrome (same state, same card)
