# Mobile: what it takes to be on par, then best in class

Written for POD-346. Everything below was checked against the code and against a
live isolated instance serving a freshly exported phone bundle — not inferred.

---

## 0. The thing that matters most: nothing you fix reaches the phone

**Your phone has never been running the code we merged.** `apps/mobile/dist` — the
bundle the backend serves at `/mobile` — was last built at **00:30 today**. The
superagent chat fix (POD-344) landed on `main` at **00:35**. Five minutes late, so
your phone is still running the broken screen. I verified it directly: the deployed
bundle contains none of POD-344's symbols.

The repo ships the units that are supposed to prevent exactly this —
`scripts/systemd/podium-web.service` ("rebuilds apps/web/dist and apps/mobile/dist …
runs at boot and on every redeploy") plus `podium-redeploy.path`/`.service`. **Neither
is installed on this machine.** Only `podium-server`, `podium-daemon` and
`podium-janitor` are. So both dists only ever change when a human remembers to run
the build by hand, and every mobile fix since has been sitting on `main`, invisible.

That single gap explains the premise of this issue: "a lot of recent changes did not
yet make it to mobile." They were written. They were merged. They were never built.

**Fix first, before any feature work:** install `podium-web.service` +
`podium-redeploy.path`, or add a deploy step that runs
`bun run --filter @podium/mobile build:web`. Until then every item below has a
five-minute shelf life.

---

## 1. The two bugs you hit

### Superagent send — "just nothing happens"

Not a send bug. The turn dispatches fine; the *screen* could not show it. The phone
built its whole transcript from `superagent.history`, which is the frozen legacy
buffer — since the harness took ownership of the conversation the server writes only
turn-failure notices there. On your live database that table has **zero rows**. So
the optimistic bubble sat on "sending…" forever and the reply never appeared.

POD-344 already rewrote the screen to read the thread's headless session transcript
(the same source the desktop's embedded `ChatView` uses). I re-verified it end to
end on a phone bundle built from current `main`: send → ack → `pong` renders. **The
code is fixed; only the deploy is missing.**

What I added on top, because "nothing happens" should be structurally impossible: a
rejected send now marks its own bubble **not sent**, prints the server's reason
under it, and offers **Try again** with the words intact. Previously a rejection —
e.g. `a turn is already running on this thread`, which is in-memory server state and
survives until restart — only set a thin banner that reads as nothing at all.

### "I added a task in the Work tab and nothing ever happened"

The Work tab's `+` opened **New session**, not New task. A session created that way
is bound to no issue and no worktree — and the Work list is derived from issues and
worktrees, so the agent it spawned was **invisible by construction**. It was not
lost: one is still running right now in `/home/podium/podium` — the *shared root
checkout, on `main`* — doing its own copy of this analysis (session `556eea2f`).

Two things wrong at once: the wrong default action, and a bare session silently
landing an unsupervised agent in the shared checkout.

Fixed: `+` now opens a sheet whose **first and primary action is New task** (which
does create an issue, branch, worktree and agent — verified end to end), with New
session one step down and each option saying where the work will end up. And a task
with nobody on it now has a **Start an agent** button on its page, so a task filed
without "start now" is recoverable from the phone.

---

## 2. Parity ledger

`✓` on the phone · `~` partial · `✗` absent.

### Already good — do not touch
| Surface | Status |
|---|---|
| Tray triage, needs-you ordering | ✓ shared viewmodels with the desktop |
| Offer cards: actions, `--action-input` feedback, artifact thumbnails | ✓ full parity |
| Work list: pinned band, project groups, agent rosters, tuck-away, Snoozed/Closed folds | ✓ same derivation as the sidebar |
| Task board with stages, proposal screening deck | ✓ |
| Session chat: Flat Field rows, tool verdicts, AskUserQuestion answering, scroll-back paging | ✓ |
| Session actions: archive, snooze, clear snooze, rename, kill | ✓ |
| Offline: replica cold-start, outboxed sends | ✓ better than most native apps |
| Terminal pane | ✓ |

### Gaps that change what you can do from the phone
| Missing | Why it hurts | Web equivalent |
|---|---|---|
| **Diff / git review** | You cannot judge a "ready to merge" offer without a laptop. This is the single biggest reason a phone session ends in "I'll look later". | `features/git` dock, `git.status/log/diffFile` |
| **Rebase / PR / merge actions** | You can read that work is done and do nothing about it. | `issues.action` |
| **Issue Artifacts section** | Every agent is instructed to attach reviewable artifacts to its issue. On the phone they are only reachable if an offer happens to name them. | `IssuePanelView` Artifacts, media previews |
| **Issue Todo list + Deferred** | The human-facing progress list agents maintain is invisible. | `DockSection` Todo / Deferred |
| **Subtasks + typed relations** | An epic reads as one flat row; blocked/blocking is a single red line of text. | `IssuePanelView` |
| **Close / archive a task** | Stage can be set to `done` but the closure reason and tuck path are desktop-only. | `issues.close`, tuck |
| **Priority / type / assignee / colour editing** | Create-time only; not editable after. | `issue-page-properties` |
| **Conversation search** | The data is already synced to the phone and unused. | `conversations.search` |
| **Mail / messages** | Cross-issue mail is invisible on mobile. | `features/messages` |
| **Usage + quota** | No way to see you are about to run out mid-flight. | `features/usage`, `quota.summary` |
| **Settings** | Connection stats and logout only. No notifications, harness choice, model/effort, repos, hibernation, accounts. | 20 sections |
| **Specs / workflows / automations / machines** | Absent. Low phone value — list for completeness, not for building. | 4 features |

### Chat gaps
| Missing | Note |
|---|---|
| Image attach / camera | Reviewing or sending a screenshot from the phone is the most natural mobile-only capability, and it is missing. Web has `imageInput` + `SendUserFileBlock`. |
| `@` references in the composer | Desktop superagent composer has them; the phone cannot point at a repo or session. |
| Model / effort switch per turn | Desktop-only. |
| Interrupt a session turn | Superagent has Stop; a normal session chat does not. |
| Queued-send visibility | `outboxSize` exists and is shown only in Settings, not where you sent the message. |

---

## 3. Mobile-native excellence — what "best in class" actually needs

Parity alone will not make this feel like a great phone app. These are the items
that are not on the desktop at all and matter more than most of the table above.

1. **Push notifications.** The whole value of Podium on a phone is "an agent needs
   you and you are not at your desk." Today the phone has *no* notification path:
   the server's `notify` module only speaks Telegram. Nothing tells you an agent
   asked a question. This is the number one feature.
   - Web push (VAPID) covers iOS 16.4+ and Android from the installed PWA.
   - It needs item 2 first.
2. **Make the phone app installable.** The desktop web app is a proper PWA
   (`vite-plugin-pwa`, manifest, workbox service worker). The Expo web export ships
   **no manifest and no service worker** — so the phone app, the one that lives on a
   home screen, is the *less* installable of the two. Add a manifest + icons +
   service worker to the mobile export, then standalone display, offline shell, and
   push all become available.
3. **Deep links from a notification into the exact card.** `/mobile/session/<id>` and
   `/mobile/issue/<id>` already route; the screening screen already has a comment
   about being opened from a notification. Wire the last mile.
4. **Voice input for prompts.** Dictating a task while walking is the phone's
   comparative advantage over a laptop. Nothing about the composer uses it.
5. **Swipe actions on rows.** Snooze / tuck / archive are the three things you do
   most in triage and each currently costs a long-press plus a sheet.
6. **Pull-to-refresh** on Tray / Work / Tasks. Absent — there is no manual way to
   force a resync when the socket is wedged, which is exactly when you want one.
7. **Android keyboard handling.** `KeyboardAvoidingView` is configured
   `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` on the superagent
   screen — Android gets nothing.
8. **A connection state you can see.** `connected` is tracked and surfaced only in
   Settings. When the socket is down the phone silently shows stale state.
9. **Widgets / Live Activities** (native builds only) — "3 agents working, 1 waiting
   on you" on the lock screen. The long game, not now.

---

## 4. Suggested order

**P0 — ship before anything else**
1. Install the redeploy/web-build units so merged fixes reach the phone. *(ops, minutes)*
2. Rebuild and deploy the current bundle — that alone fixes superagent sending.
3. Task creation from Work + Start-an-agent recovery. *(done in this issue)*
4. Rejected sends become visible and retryable. *(done in this issue)*

**P1 — the phone becomes decision-capable**
5. Push notifications, which requires the mobile PWA shell (manifest + service
   worker) first, then deep links into the card.
6. Diff review + merge/PR/rebase from the issue screen.
7. Issue screen to real parity: artifacts, todo, deferred, subtasks, close.

**P2 — the phone becomes pleasant**
8. Image attach / camera in the composer.
9. Swipe actions, pull-to-refresh, visible connection state, Android keyboard.
10. Voice input.

**P3 — completeness**
11. Settings that matter on a phone (notifications, harness, model/effort).
12. Conversation search; usage + quota; mail.

---

## 5. Changed in this issue

- Work tab `+` is task-first, with an explicit choice and a note on where each
  option's work lands (`WorkScreen`, `ActionSheet` gains a `hint`).
- Task page: `Start an agent` when nobody is on it; the human-facing ref
  (`DEM-2`) instead of the internal `#seq` (`IssueScreen`).
- A rejected superagent send marks its bubble **not sent**, names the reason, and
  offers **Try again** (`TranscriptList`, `SuperagentScreen`).

Screenshots: `work-add-task-first.png`, `issue-start-an-agent.png`,
`superagent-send-failed-retry.png` — all captured from a real bundle against a live
isolated instance, not mocks.
