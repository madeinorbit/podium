# @podium/daemon

The Podium daemon, installed on each dev machine. Spawns and attaches agent CLIs via
`@podium/harness` and PTYs via `@podium/pty`, runs harness/project/worktree discovery, exposes live PTY
streams, and maintains a connection to `@podium/server`. The shipped daemon runs under
Bun and uses Bun's terminal API for PTYs.

Harness variance lives in `@podium/harness`; PTY mechanics live in `@podium/pty`. This app orchestrates both for one machine.
