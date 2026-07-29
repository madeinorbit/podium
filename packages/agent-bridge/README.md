# @podium/agent-bridge

The harness half of the coding-agent bridge. Runs on Node and knows how each
native agent CLI (Claude Code, Codex, Grok, Cursor, opencode) is launched,
resumed, run headless and probed — plus agent-state classification, transcript
location and installed-CLI discovery.

The PTY half lives in [`@podium/pty`](../pty): swappable PTY backends, the
durable session hosts (abduco/tmux/systemd scopes), byte framing, OSC title scan
and redraw. That package is harness-agnostic on purpose — behavioral branching on
harness identity belongs here, in the adapters, and nowhere else. This barrel
does not re-export it; import `@podium/pty` directly.

Published to npm. Depends on `@podium/protocol`. Pairs with
`@podium/terminal-client` on the browser side, but never imports it.

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
