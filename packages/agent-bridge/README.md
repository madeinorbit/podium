# @podium/agent-bridge

The coding-agent process wrapper. Runs on Node and drives native agent CLIs
(Claude Code, Codex) as PTY-backed sessions — spawning/attaching tmux-style with no
`-p` abstraction, handling resize/`SIGWINCH`, streaming output, injecting input,
managing controller/spectator multi-client control, extracting transcripts, and
discovering installed CLIs.

Published to npm. Depends only on `@podium/protocol`. Pairs with
`@podium/terminal-client` on the browser side, but never imports it.

Intended runtime dependency (added when implementation begins): `node-pty`.

## Conversation discovery

`scanAgentConversations` discovers local agent conversation metadata before any
full transcript is loaded. By default it checks the standard agent data roots:
Codex `~/.codex` and Claude Code `~/.claude`.

Codex scanning reads `sessions/**/*.jsonl` and, when present, optional
`state_*.sqlite` files. Claude Code scanning reads top-level
`projects/*/*.jsonl` files plus nested subagent transcripts at
`projects/*/<session>/subagents/*.jsonl`.

Use `extraRoots` for additional known agent data directories, such as archived
or migrated Codex and Claude roots. These roots are scanned with the same
provider-specific rules; they are not broad disk crawling.

```ts
import { loadAgentConversation, scanAgentConversations } from '@podium/agent-bridge'

const result = await scanAgentConversations({
  extraRoots: {
    codex: ['~/agent-archives/codex'],
    'claude-code': ['~/agent-archives/claude'],
  },
})

for (const summary of result.conversations) {
  console.log(summary.agentKind, summary.title, summary.updatedAt)
}

const conversation = await loadAgentConversation(result.conversations[0])
```

The scan result contains conversation summaries for listing and filtering, plus
diagnostics for malformed candidate files and unreadable roots or files where
the scan can continue instead of crashing.
Call `loadAgentConversation` with a summary when full messages are needed. The
scanner does not generate summaries, embeddings, search indexes, or grouping
metadata itself.
