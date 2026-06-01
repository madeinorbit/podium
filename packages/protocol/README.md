# @podium/protocol

The wire protocol shared by Podium's agent process wrapper and its browser terminal
client. Defines the message types that cross the network boundary: output frames, input
events, resize, controller/spectator takeover, session lifecycle, and transcript.

Published to npm. Both `@podium/agent-bridge` (Node) and `@podium/terminal-client`
(browser) depend on it; they never depend on each other.
