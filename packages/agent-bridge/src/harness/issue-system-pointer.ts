/**
 * Always-on hint injected into interactive Claude Code's system prompt so the
 * agent knows the `podium issue` CLI exists and how to use it, even without a
 * hook-delivered `prime`. Concise and static (no per-session data): it points at
 * the tools, not a specific issue. Only claude-code gets this (the interactive
 * `claude` CLI supports `--append-system-prompt`); other agents rely on the
 * committed guide + hook-injected prime. See docs/agents/podium-issues.md.
 */
export const ISSUE_SYSTEM_POINTER =
  "This project uses Podium's issue tracker. You have a `podium issue` CLI. " +
  'Run `podium issue prime` for your current issue, workflow, and ready work. ' +
  'Track durable or discovered work as issues (`podium issue create ...`, link a follow-up with ' +
  '`podium issue dep-add --fromId <new> --toId <current> --type discovered-from`), not markdown TODO files. ' +
  '`podium issue ready` lists unblocked work; ' +
  '`podium issue claim`/`close` as you go. Editing an issue outside your assigned one needs `--outside-scope`. ' +
  'If this session is on the wrong issue (or a draft), re-home it: `podium issue attach --id <issue>` ' +
  'to join an existing issue, or `podium issue attach --subissue "<title>"` for a new piece of work. ' +
  "If you discover something another issue's agent should know (a fix to merge, a conflict, a dependency), " +
  'send it mail: `podium issue mail send <id> --body "…"` — it is delivered to whoever works that issue.'
