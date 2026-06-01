# @podium/daemon

The Podium daemon, installed on each dev machine. Spawns and attaches agent CLIs via
`@podium/agent-bridge`, runs harness/project/worktree discovery, exposes live PTY
streams, and maintains a connection to `@podium/server`. Runs under Node for `node-pty`
compatibility.

Skeleton only. The agent-wrapping logic lives in `@podium/agent-bridge`; this app
orchestrates it for one machine.
