// Moved to @podium/issue-client (Phase 3 step 4): the `podium issue` command
// TABLE (names, summaries, zod arg shapes, positionals, client-side run/render
// bodies) is shared by the CLI and the in-process MCP. The server-side proc
// bodies live in modules/issues/commands.ts (IssueCommandService), unchanged.
export {
  ISSUE_COMMANDS,
  type IssueCommand,
  type IssueCommandResult,
} from '@podium/issue-client'
