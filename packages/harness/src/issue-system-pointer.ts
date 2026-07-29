/**
 * Always-on hint injected into interactive Claude Code's system prompt so the
 * agent knows the `podium issue` CLI exists and how to use it, even without a
 * hook-delivered `prime`. Concise and static (no per-session data): it points at
 * the tools, not a specific issue. Only claude-code gets this (the interactive
 * `claude` CLI supports `--append-system-prompt`); other agents rely on the
 * committed guide + hook-injected prime. See docs/agents/podium-issues.md.
 */
import { SPINOFF_RULE_TERSE, TITLE_RULE_TERSE } from '@podium/protocol'

export const ISSUE_SYSTEM_POINTER =
  "This project uses Podium's issue tracker. You have a `podium issue` CLI. " +
  'Run `podium issue prime` for your current issue and ready work. ' +
  'Discovered work that can ship separately becomes a top-level issue plus a `discovered-from` dependency; it lands in Proposed automatically, so do not claim or stage it. ' +
  'Decomposition required for your deliverable becomes an internal sub-issue under the current issue; blocking adjacent work is also a blocking sub-issue. ' +
  'Write `--description` as 1–3 plain, context-free sentences for the human and put technical detail/instructions in `--brief`. [spec:SP-6144] ' +
  '`podium issue ready` lists unblocked work; ' +
  '`podium issue claim`/`close` as you go. Nothing advances an issue for you: an issue you are actively ' +
  'working must never sit in `backlog` — set the stage yourself with ' +
  '`podium issue update --id <id> --stage planning|in_progress|review` as the work moves. Note that ' +
  'creating or retitling an issue leaves it in `backlog`; only `claim` sets `in_progress`. ' +
  'Editing an issue outside your assigned one needs `--outside-scope`. ' +
  // Issue identity is immutable [spec:SP-9c7b].
  'Never reuse an existing issue for something completely different — new work gets a new issue or ' +
  "sub-issue. Switch yourself to it only on the human's push; otherwise file it for another agent. " +
  // Cross-issue reattach is blocked [spec:SP-8744]; only a draft may attach --id.
  'A session on a DRAFT may join the issue that covers its work: `podium issue attach --id <issue>`. ' +
  'Once on a real issue you cannot reattach elsewhere — for a new piece of work you move onto, use --spinoff/--subissue below. ' +
  // Git-state attribution [POD-98]: trailers keep shared-branch commits attributable.
  'When you commit on a SHARED branch (main or a long-lived project branch), add a trailer line ' +
  '`Podium-Issue: <your issue ref>` to the commit message so the commit stays attributable to your issue. ' +
  SPINOFF_RULE_TERSE +
  ' A native subagent must not self-attach; its parent attaches it. Otherwise, file it for another agent. ' +
  "If you discover something another issue's agent should know (a fix to merge, a conflict, a dependency), " +
  'send it mail: `podium issue mail send <id> --body "…"` — it is delivered to whoever works that issue. ' +
  // Issue artifacts: reviewable deliverables live ON the issue, not only in chat.
  'Any reviewable deliverable you produce for your issue (UX shots, mockups, concept docs, HTML/MD proposals) ' +
  'must ALSO be attached to the issue so it shows in its sidebar: save it to a durable path inside the ' +
  'worktree/repo (never a scratchpad or /tmp — those paths do not render), then ' +
  '`podium issue artifact <id> --add <path> --title "…"`. Re-add each significant iteration; the issue ' +
  'artifact list is how the human finds and reviews visual work later, even after the chat scrolls away. ' +
  // Agent action offer [spec:SP-c7f1]: suggested next actions the user can click.
  'When you finish a turn and there are natural next actions the user might pick, offer them: ' +
  '`podium offer --message "…" --action "Label::prompt to send when clicked"` (repeat --action — prefer 2–3, ' +
  'up to 6 only when the decision genuinely branches that wide; `podium offer clear` to remove). ' +
  'Write the offer to be judged in five seconds, cold, from a tray of many: the FIRST LINE of --message becomes ' +
  'the card headline — state the outcome as done ("Login screen ready to merge"), never the activity ' +
  '("I\'ve been working on…"); at most two more lines add where things stand and the one thing to judge. ' +
  'One decision per offer — a second topic is a discovered issue or the next turn\'s offer, never a "by the way". ' +
  'Action labels are imperative, ≤3 words, recommended action FIRST (it renders as the primary button). ' +
  'An action that only makes sense WITH an explanation (send back, request changes) ' +
  'must use `--action-input "Label::prompt"` instead — the UI collects the user\'s feedback and appends it to the prompt. ' +
  'Attach the evidence: `--artifact <path>` names issue artifacts (added via `podium issue artifact --add` the same turn) ' +
  'that render as thumbnails so the user can judge without opening the session. ' +
  'Curate review evidence explicitly with repeated `--artifact <path>` in priority order: put the single best review ' +
  'target first (including an interactive HTML concept when it carries the interaction), then supporting screenshots. ' +
  'Offer cards render at most three artifact items, so choose the three most useful rather than every frame. ' +
  'Failures are offers too — cause, fix, decision, matter-of-fact; no apologies. ' +
  'The buttons show under the chat and as a card in the Tray; ' +
  'a user turn clears the offer, and so does your own next turn (a stale offer self-clears once the conversation moves on). ' +
  'When you move your issue to `review`, ALWAYS post an offer naming the next steps (merge via --action, send back via --action-input, …) — ' +
  'the Tray surfaces review-ready work ONLY through your offer, the stage alone renders nothing. ' +
  'Before posting, test it: reading only the first line and the buttons, does the user know (a) what happened and (b) what to decide? ' +
  TITLE_RULE_TERSE

/**
 * Companion pointer for the living project spec (pspec, #135). Same delivery as
 * ISSUE_SYSTEM_POINTER (claude-code --append-system-prompt); other agents rely on
 * the committed guide docs/agents/podium-specs.md and `podium spec prime`.
 */
export const SPEC_SYSTEM_POINTER =
  'This project keeps a living spec of explicit human decisions in <repo>/pspec/, maintained via the ' +
  '`podium spec` CLI — run `podium spec prime` for the rules and current tree. ' +
  'Before non-trivial work, check `podium spec tree`/`podium spec search <text>` and comply with decisions ' +
  'touching your task; a [spec:SP-xxxx] comment in code means `podium spec show SP-xxxx` first. ' +
  'When the human states a decision or gives project context, record it in the spec (concise rewrite, ' +
  'right component; `podium spec create/update`). Record ONLY explicit human decisions — never the obvious ' +
  'or standard best practice, unless the human contradicts best practice (confirm, then record the why). ' +
  'Flag contradictions between new input and the existing spec instead of silently overwriting; ' +
  'ask for clarification when input is ambiguous in a way that matters now. ' +
  'Reference implemented components in code comments as [spec:SP-xxxx].'
