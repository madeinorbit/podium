# Claude Enter measurement

Measurement in progress. Production typing remains unchanged until the real-PTY
evidence is collected.

The rig uses Podium's `createTerminalInjection` and `bunTerminalBackend`, a fresh
scratch HOME, and a loopback fake Anthropic server. It will compare installed
Claude Code 2.1.283 and 2.1.289 across 0/30/90/200/500 ms paste-to-CR delays,
idle/streaming/tool/compacting states, short/multiline/over-800-character bodies,
and CPU load. Each case saves the actual writes, screen, and relevant transcript
records before a recovery CR, and after the busy state ends.

Repository regression tests run only in the private flatblock checkout through
`bun run test:file`, including an initial red test and one restored mutant.
