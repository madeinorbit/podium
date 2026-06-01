# @podium/terminal-client

The browser presentation client for Podium agent terminal sessions, on web and mobile —
including the same session attached to two clients at once. Framework-agnostic core:
xterm.js rendering, a mobile auxiliary-key toolbar, an explicit touch/scroll policy
(TUI scroll vs terminal scrollback), reconnect/backpressure handling, controller and
spectator rendering, and a separate transcript surface. See
`docs/mobile-web-agent-cli-challenges.md` for the constraints this package answers.

Published to npm. Depends only on `@podium/protocol`. Pairs with `@podium/agent-bridge`
on the server side, but never imports it.

Intended runtime dependencies (added when implementation begins): `@xterm/xterm` and
relevant xterm addons. A React adapter may later be split into
`@podium/terminal-client-react`.
