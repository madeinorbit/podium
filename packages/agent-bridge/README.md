# @podium/agent-bridge

The coding-agent process wrapper. Runs on Node and drives native agent CLIs
(Claude Code, Codex) as PTY-backed sessions — spawning/attaching tmux-style with no
`-p` abstraction, handling resize/`SIGWINCH`, streaming output, injecting input,
managing controller/spectator multi-client control, extracting transcripts, and
discovering installed CLIs.

Published to npm. Depends only on `@podium/protocol`. Pairs with
`@podium/terminal-client` on the browser side, but never imports it.

Intended runtime dependency (added when implementation begins): `node-pty`.
