// Moved to @podium/issue-client (Phase 3 step 4): the `podium issue` command
// TABLE (names, summaries, zod arg shapes, positionals, client-side run/render
// bodies) is shared by the CLI and the in-process MCP. The server-side command
// bodies live in the command registry (modules/issues/registry.ts, #248).
export {
  ISSUE_COMMANDS,
  type IssueCommand,
  type IssueCommandResult,
} from '@podium/issue-client'
