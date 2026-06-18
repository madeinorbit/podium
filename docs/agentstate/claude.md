# Claude Code Agent State Rules

This document describes the deterministic classifier for Claude Code in Podium. It is intentionally split into layers so the same global state model can be reused for other coding agents.

## Layering

1. **Global deterministic state model**
   - Implemented in `packages/agent-bridge/src/agent-state/deterministic.ts`.
   - Defines labels shared by all agents, plus the special internal state `needs_semantic_classification`.
   - Maps resolved labels to the existing `AgentStateEvent` stream. The wire protocol is unchanged for now.

2. **Claude Code data extraction**
   - Implemented in `packages/agent-bridge/src/agent-state/claude-code-classifier.ts`.
   - Converts Claude JSONL records into `ClaudeTranscriptFeatures`.
   - This layer is Claude-specific: hook names, transcript record shape, `tool_use`/`tool_result`, `promptSource`, `permission_mode`, and Claude's interrupt marker.

3. **Claude Code deterministic rules**
   - Also in `claude-code-classifier.ts`.
   - Maps `ClaudeTranscriptFeatures` to the global deterministic labels or `needs_semantic_classification`.
   - These rules should stay cheap, auditable, and conservative.

4. **Global event mapping**
   - Implemented in `deterministicStateToEvents`.
   - Resolved deterministic states become current `AgentStateEvent`s.
   - `needs_semantic_classification` currently falls back to `turn_completed` with no verdict, which the reducer treats as idle/done. This is intentional: until semantic classification is installed, ambiguous stopped turns should not spam user-facing needs-input notifications.

## Global Labels Used

- `new`
- `working`
- `working.waiting_on_subagent`
- `working.waiting_on_shell`
- `error`
- `idle.finished`
- `idle.interrupted`
- `idle.needs_input.ask_user_tool`
- `idle.needs_input.permission`
- `idle.needs_input.approval`
- `idle.needs_input.open_todo_list`
- `idle.needs_input.text_question`
- Internal only: `needs_semantic_classification`

## Claude Extraction Rules

The extractor scans the current turn after the latest real user prompt. A user record is not considered a real prompt when it is a tool result or `promptSource: "system"`.

Extracted signals:

- Last real user text and real user turn count.
- Last assistant text and `message.stop_reason`.
- Terminal interrupt marker: `[Request interrupted by user]`.
- Unresolved `tool_use` calls by id.
- Current unresolved `AskUserQuestion` payloads.
- Open todo count from the latest `TodoWrite` tool input.
- Foreground and background `Bash` commands.
- `Agent` calls and whether they were background-launched.
- Tool-result errors.
- Terminal event type: assistant text, tool use, tool result, or user text.
- Claude `permission_mode`.

## Claude Deterministic Rules

Rules are ordered. Earlier rules win.

1. **No transcript activity**
   - No real user turns and no assistant text -> `new`.

2. **Terminal user interrupt**
   - Terminal `[Request interrupted by user]` -> `idle.interrupted`.
   - This outranks plan mode and questions.

3. **Plan approval**
   - `permission_mode === "plan"` -> `idle.needs_input.approval`.

4. **Current explicit user-input tools**
   - Unresolved `AskUserQuestion` -> `idle.needs_input.ask_user_tool`.

5. **Unresolved tool work**
   - Unresolved `Agent` -> `working.waiting_on_subagent`.
   - Unresolved `Bash` -> `working.waiting_on_shell`.
   - Other unresolved tools -> `working`.
   - A tail ending on a `tool_result` -> `working`; the agent should wake for the next model step.

6. **Explicit terminal error**
   - Rate limit, usage limit, provider exhaustion, 500/502/503, auth/billing failure, insufficient credits, or context-length stop -> `error`, unless the final assistant text also clearly reports completed work.

7. **Explicit wait language**
   - Text saying it is waiting on shell/tests/build/server/etc. -> `working.waiting_on_shell`.
   - Text saying it is waiting on subagent/reviewer/worker/etc. -> `working.waiting_on_subagent`.

8. **Autonomous continuation language**
   - Text such as "I'll continue", "I'll report back", "will resume", or "when it finishes" -> `needs_semantic_classification` unless a stronger deterministic rule already matched.

9. **Open todo list**
   - Open todos with no autonomous continuation and no terminal question -> `idle.needs_input.open_todo_list`.

10. **Completed work plus optional follow-up**
    - Completion language plus optional follow-up wording -> `idle.finished`.
    - Examples: "Done. Tests pass. Want me to push?" or "Summary... Let me know if you want me to also update docs."
    - This is the main false-positive reduction from the V2 experiment.

11. **Required user action or decision**
    - Required action/decision language -> `idle.needs_input.text_question`.
    - Examples: "please authenticate", "tell me when", "choose", "which approach", "approve", "confirm", "should I...", "do you want me to...", or "want me to proceed/continue/start/run/delete/commit/merge/push/open/implement/apply".

12. **Terminal non-courtesy question**
    - A final question that is not clearly optional -> `needs_semantic_classification`.
    - The semantic layer should decide between `idle.finished` and `idle.needs_input.text_question` using product semantics.

13. **Declarative final assistant text**
    - Final assistant text with no current blocker -> `idle.finished`.

14. **Fallback**
    - Anything else -> `needs_semantic_classification`.

## Semantic Classification Boundary

The deterministic classifier intentionally does not decide every terminal question. It returns `needs_semantic_classification` when the final text requires judgement about whether a question is a blocker or an optional next task.

Until the semantic classifier is installed, these ambiguous stopped turns map to idle/done at the event layer. This avoids false needs-input notifications, which are worse UX than missing a small number of ambiguous asks.

## Known Limitations

- The rules are English-biased.
- Open todo detection uses the latest observed `TodoWrite` payload; it does not yet read an external todo store.
- Background shell/subagent detection is deterministic only when Claude exposes a current unresolved tool or explicit waiting/background language.
- `idle.needs_input.open_todo_list` does not yet have a dedicated wire verdict; it falls back through the existing reducer model.
- The global `new` label exists internally, but the current wire protocol still treats fresh boot as `session_started` -> idle.
