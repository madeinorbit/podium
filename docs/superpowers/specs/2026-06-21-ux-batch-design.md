# UX Batch 2026-06-21 — Design

Worktree: `worktree-ux-batch-2026-06-21` (branched from local `main` `0bee95c`).
Leave unmerged for user review. Runtime-verify interactive items before claiming done.

## Decisions (user-confirmed)

- **Superagent:** full rebuild now — harness mode spawns a real agent (Claude/Codex/etc.)
  with tools + MCP + our injected system prompt, streamed into the superagent chat view.
  User picks preferred agent in settings.
- **Claude warning:** choosing Claude as the superagent harness warns it
  "consumes your Claude usage / rate limits".
- **tl;dr:** chat-toolbar button → posts the last agent answer into this session's
  BTW superagent thread for a concise tl;dr (with enough context).
- **CWD:** displayed in the chat/session header.

## Workstreams & items

### A. Sidebar — `apps/web/src/Sidebar.tsx`, `derive.ts`, `home.ts`, `styles.css`

1. **Pin icons default-invisible.** `PinButton` hidden unless pinned; appears on row
   hover (`group-hover`). When hidden, item text uses full width. Pinned pins stay visible.
2. **Stale section.** Within each worktree group AND the NEEDS-YOUR-ATTENTION group:
   if total sessions in the group > 5 AND there are > 3 non-working sessions inactive
   > 16h, keep the 3 most-recently-active visible and collapse the remaining stale
   candidates into a `Stale` subsection (collapsed by default) at the bottom of that group.
   "Non-working" = `attentionGroup(s) !== 'working'`. "Inactive > 16h" = `now -
   Date.parse(lastActiveAt) > 16h`. Pure partition fn in `derive.ts` (TDD).
3. **Worktree sort.** (a) Closed `Select` shows the human label ("Last used") not the raw
   value (`lastUsed`) — map value→label in `SelectValue`/placeholder. (b) Debug & fix why
   selecting a sort order has no effect on ordering (suspect `setSidebarSettings` optimistic
   state not updating, or sorted list not used for the visible repo list).

### B. Chat view — `apps/web/src/ChatView.tsx`, `chat.ts`, `markdown.ts`, `AgentPanel.tsx`

4. **SendUserFile images.** Detect the `SendUserFile` tool in the transcript; render its
   image file(s) inline in chat, clickable → lightbox overlay. Non-image files render as
   a file chip. Images served via existing `apps/server/src/file-asset-route.ts`.
5. **Sticky last user message.** The last *sent* user message sticks to the top of the
   chat viewport once the view has scrolled past it toward newer content; it scrolls out
   normally at the bottom. Implement with a sticky duplicate header + scroll/IntersectionObserver.
6. **Recap special-case.** Claude Code recap message rendered as a distinct "Recap" block,
   not generic "System". Detect recap shape in transcript ingestion / chat rendering.
7. **Churned duration + live timer.** Parse Claude's "Churned for 18m 24s" from the
   transcript and display it on the recap/answer. Add a general live "since last stop"
   timer in the chat activity row.
8. **tl;dr button.** Chat-toolbar button → sends the last answer into the session's BTW
   thread asking for a concise tl;dr (opens superagent dock on the BTW thread).
9. **CWD in chat/session header.** Small path near the title (`session.cwd`).
10. **Chat/native toggle → icon toggle.** Replace the two adjacent Buttons in
    `AgentPanel.tsx` with a single segmented icon toggle.
11. **Dead-session chat.** For exited sessions that are chat-capable, render `ChatView`
    (transcript already fetched from disk for parked sessions) with a small banner,
    instead of replacing it with `ExitedPane`. Keep a way to see exit detail / resume.

### C. Superagent rebuild — `apps/server/src/superagent.ts`, `llm.ts`, `apps/daemon/src/daemon.ts`, `packages/core/src/settings.ts`, `packages/protocol/src/messages.ts`, `apps/web/src/SuperagentView.tsx`, `router.ts`

12. Harness-backed superagent turn runs a real agent process (reusing daemon spawn infra)
    with our system prompt (`--append-system-prompt` / equivalent), MCP config, and tools,
    streaming output into the superagent chat thread rather than one-shot `claude -p`.
    Settings: surface `superagent.harnessAgent` selection in the web settings UI; when
    `claude-code` is selected, show the usage/limits warning.
    Keep the existing API tool-loop path intact as an alternative.

### D. Codex / Claude naming & titles — `packages/agent-bridge/src/agent-state/codex.ts`, `discovery/providers/codex*.ts`, `discovery/scanner.ts`, `apps/daemon/src/daemon.ts`, `apps/server/src/title-filter.ts`, `relay.ts`

13. **Codex names.** Prefer the native state-DB `title` (set richer/earlier); fall back to
    first prompt. Consider cwd/git for context. (Already partly wired via `onTitle`.)
14. **Codex duplicate on resume.** Dedup by resume ref (codex thread id) so the same agent
    doesn't appear twice — guard at session registration / discovery merge.
15. **Claude title speed.** If the OSC title stays generic ("Claude Code") past a short
    timeout after start, fall back to the transcript first user prompt so it names faster.

### E. Mobile & terminal — `apps/web/src/MobileApp.tsx`, `store.tsx`, `AgentPanel.tsx`, `Workspace.tsx`, `packages/terminal-client/src/url-link-provider.ts`, `terminal-view.ts`

16. **Mobile file open.** Debug why a transcript file-link opens a shell on mobile instead
    of the file viewer; fix so `openFile` shows the file panel on mobile (suspect MobileApp
    not handling `file:` tabs / pane routing). systematic-debugging.
17. **Sentry multiline link.** Fix terminal wrapped-URL hit region so the whole multi-line
    link is clickable, not just the first line (Sentry auth wrapping pattern). Add a
    regression test mirroring the Sentry wrap shape.
18. **Vertical tab list (mobile).** When the session/tab list reaches full height, scroll
    within a max height and overlay above content (not push content down).

## Verification

- Per workstream: `bun run` typecheck/build for affected packages; unit tests for pure fns.
- Interactive items (pins, stale, sticky message, toggle, lightbox, mobile file open,
  terminal link): runtime-verify via the committed Playwright harness against the live UI.
- Commit per workstream so no work is lost.
