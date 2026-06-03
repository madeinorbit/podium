# Multiple Sessions — Phase 7: Real-Agent Launcher + Resume Smoke

**Goal:** Update the manual/on-device launchers to the multi-session flow and validate that real `claude --resume <id>` actually attaches through the relay (the flag the prototype abstracts).

**Approach:** Done inline (launcher scripts + a manual smoke; not unit-testable). The workspace gates don't cover `e2e/*.ts` scripts, so validation is "they run against real `claude`."

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §11 phase 4 / §7 resume.

---

## Changes

1. **`e2e/serve.ts`** — passive daemon (`startDaemon({ serverUrl })`, real `claude`/`codex` via the default `agentLaunchCommand`) + `server.registry.createSession(...)` for a starter session + print desktop/phone `?server=` URLs. The web **Live** section (auto-opened by `?server=`) lists sessions; create/resume/kill from the UI.
2. **`e2e/run-claude-demo.ts`** — multi-session: create a session, attach a raw multiplexed client (`hello` → `attach{sessionId}` → `redrawRequest{sessionId}`, filter `outputFrame` by `sessionId`), print claude's screen. A prompt is typed only if `PROMPT` env is set (default = render-only, no quota).
3. **`e2e/run-resume-smoke.ts`** (new) — `scanAgentConversations()` → resume the most recent claude conversation via `registry.resumeSession(...)` → attach → confirm it renders + no `spawnError` (validates `claude --resume <id>`). No prompt typed → no quota.

## Validation (run against real `claude`)

- `bunx tsx e2e/run-claude-demo.ts` → claude welcome renders through the multi-session relay (bytes > 0).
- `bunx tsx e2e/run-resume-smoke.ts` → a real conversation resumes + renders (flag confirmed), or surfaces the actual error to fix the launcher.

## Non-goals

Codex resume is validated only if `codex` is installed; otherwise the launcher abstraction is the single swap point (documented). No CI gate (real-agent + auth dependent).
