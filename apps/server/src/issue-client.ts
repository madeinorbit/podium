// Moved to @podium/issue-client (Phase 3 step 4): the client seam is shared by
// the CLI (apps/cli) and this server's in-process MCP. Re-exported here so
// apps/server import sites stay stable. The IssueTrpc type is now structural
// (see the package) — server-side proxy impls already cast to it.
export { type IssueTrpc, makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'
