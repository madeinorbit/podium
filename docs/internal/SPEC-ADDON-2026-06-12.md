# Spec addon — 2026-06-12

New direction from the founder, delta against `SPEC.md`. Where this conflicts with the
spec, this addon wins; where it's silent, the spec stands.

## 1. Settings section *(new — spec had no settings surface)*

A clean, well-structured settings area. First content:

- **Default agent + default model per usage type**: new sessions, subagents, superagent,
  background work-LLM. Default everywhere: *"leave it up to the agent"*.
- Provider/API-key management lives here too (superagent + work-LLM backends, below).

## 2. Superagent execution backends *(concretizes spec §5.3 "configurable harness/model/provider")*

- **Harness-backed**: run the superagent on a coding-agent CLI. Codex's terms allow
  programmatic use of the subscription → effectively free backend. Claude's `claude -p`
  bills pay-per-use even on a subscription — the UI must say so where the user picks.
- **API-backed**: any provider with an API key; **OpenRouter is the default**. Vercel AI
  SDK is a candidate abstraction (undecided).
- The **work-LLM** (background summarizing, state extraction, naming) gets the same
  harness/provider/model choice, configured separately.
- The superagent **needs tools**: create worktrees, start/stop agents, git operations,
  search conversations, tickets. Open question (recorded, not resolved): can the
  superagent run off API while spawned *worker* agents still use the subscription?
  (Yes — it orchestrates interactive harness sessions; only its own reasoning is metered.)
- **@-context menu** in the superagent input: typing `@po…` searches repos, worktrees,
  conversations, tickets. Files come later (noted, not now).

## 3. Chat view *(expands spec §5.4 "toggle native ↔ parsed view" + "low-bandwidth mode" into a first-class feature)*

- Per-agent **instant switch chat ⇄ native**. Chat is the preferred view on mobile;
  native preferred on desktop.
- Design/structure as close as possible to Claude Code desktop/web — it's what people
  know and it's well thought through.
- Chat view **can send messages** (writes through to the harness input).
- **Quick hybrid search** over the transcript.
- **Birds-eye minimap** (Sublime-style, top right): fast scroll across the whole
  transcript; highlights where the user prompted and where the agent worked; click
  scrolls to that point.
- **Full markdown rendering** plus special agent tags (`[image]`, `[file]`…) with links
  and previews.

## 4. Connection indicator *(refines the existing dot)*

Needs an icon, and on hover a tooltip that explains the situation **including a number**
(latency ms / reconnect state).

## 5. Home view *(concretizes spec §5.2 "board of workstreams" — THE differentiator)*

- All agent sessions, **prioritized**: needs-input at top → idle-with-recent-activity
  (today) → active; ordered by recent activity within each group.
- Premise: the user should know **where their attention is needed**. Maximize signal:
  a generic "(needs input)" on every finished session is low-signal; surfacing the *real
  question* the agent asked is high-signal.
- **Kanban option**: user sorts sessions into Planning / Implementing / Testing / Done /
  Icebox (Parked). User-draggable state.
- Every session needs a **good name**: user-set, else derived from the transcript.
- Big win: derive the **state of the WORK** (not the agent) by feeding the transcript to
  the work-LLM.
- **Lost-work section**: sessions that produced code that never merged. Requires tracking
  branches/commits a session produced and checking merge status against the repo.
- **Archive button** on sessions so users can clean their views.

## 6. Sidebar *(refines spec §5.2)*

Compact mirror of the command center, plus: start new work in any worktree, open a shell
anywhere, jump into a repo/worktree. Command center + sidebar are — next to rock-solid
native session access synced across devices — **the core feature**.

## 7. Agent (native) view improvements

- Easy access to all user prompts, especially the initial one.
- Birds-eye / scroll-to-point in the native terminal too if feasible (best effort).

## 8. Voice input

- On superagent and native agents.
- Bridging the client mic to the harness's native voice input would be wild — **don't
  over-invest** if unrealistic.
- Fallback: speech-to-text via API (browser Web Speech first; subscription reuse for STT
  is likely not allowed — don't rely on it).

## 9. Conversation search *(concretizes spec §5.5)*

- Dedicated view over past conversations; each has a **name + state summary** generated
  by the command center (not the history module) and **stored in the DB** when set.
- **Hybrid keyword/vector** search; filter by repo/worktree, default filter picked up
  from where the search was started.
- Quick access to the superagent for agentic search.
- **Mini version** in the new-panel flow: today too many conversations load; must be an
  HTML dropdown (not native select), with a search bar and last-active dates.

## 10. Usage status bar + analytics *(concretizes spec §5.9)*

- Usage windows in the status bar: **5h and weekly** across subscriptions (grok adds
  monthly). Consider reusing OSS (e.g. ccusage) for broad coverage rather than
  reinventing parsing.
- **Analytics view**: how much got done, tokens spent, API-cost equivalent — over time.

## 11. Notifications *(concretizes spec §5.8)*

Web-standard push, plus native mobile via the free webapp-push bridge apps (ntfy-style)
for platforms without an installed app. Spec's smart routing still applies.

## 12. Ticket system: Linear

Connect Linear so the superagent can pick up / add / move tickets.

## 13. Auto-hibernation *(concretizes spec §5.10)*

- When host memory exceeds a threshold (**80% default, configurable in settings**),
  auto-hibernate idle sessions.
- Opening a hibernated tab offers **one-click resume**.
- Hibernated sessions render differently in tab bar + sidebar (Firefox snoozed-tab
  inspiration).

## Implementation order (chosen)

Foundations first (settings, session metadata: name/archive/work-state), then attention
(home view), then transcripts (chat view, search), then superagent, then ops features
(usage, notifications, hibernation, voice, Linear). Small fixes (connection indicator)
land early as warm-ups.
