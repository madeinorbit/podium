# Challenges Running Agent CLI TUIs in Mobile Web

This note summarizes practical difficulties that arise when exposing terminal-based AI coding agents, such as Claude Code or Codex CLI, through a mobile web UI. The focus is neutral and implementation-oriented: these tools are designed primarily for interactive desktop terminals, while mobile browsers provide a very different input, rendering, and lifecycle environment.

## Core mismatch

Claude Code and Codex CLI are terminal applications. In their richer modes, they behave like full-screen TUIs rather than append-only command-line programs. A mobile web UI usually embeds a browser terminal emulator connected to a server-side PTY. That creates several layers that must stay aligned:

- the mobile browser viewport
- the browser terminal emulator
- the server-side PTY size
- the shell process
- the agent CLI's TUI state
- the transport layer carrying terminal bytes and input events

Small mismatches between those layers can produce confusing behavior: unreadable redraws, lost scrollback, incorrect touch scrolling, keyboard problems, or stale sessions after reconnect.

## Terminal geometry and redraw

Full-screen TUIs rely heavily on terminal dimensions. They paint text at specific rows and columns, clear regions, and react to `SIGWINCH` resize events. Mobile web complicates this because dimensions change frequently:

- orientation changes
- browser chrome appearing/disappearing
- soft keyboard opening
- virtual viewport vs layout viewport differences
- switching between desktop and mobile clients attached to the same PTY
- device pixel ratio and font metric differences

If the browser terminal and the PTY disagree about columns or rows, cursor-addressed output can wrap or land in the wrong cells. If the PTY is resized to the same size it already had, some programs may not receive a useful redraw signal. A robust implementation often needs an explicit repaint strategy: resize the PTY, force a real geometry change when necessary, and ask the TUI to redraw.

## Scrollback vs TUI scrolling

A major source of confusion is that there are two different kinds of scrolling:

1. **Terminal scrollback**: the terminal emulator's historical buffer of lines that previously flowed off-screen.
2. **TUI viewport scrolling**: the agent CLI repainting older conversation content into the current visible grid in response to mouse wheel, PageUp/PageDown, or other input.

Desktop use often feels seamless because a trackpad or mouse wheel can be routed to the active TUI. On mobile, a finger swipe may instead scroll the browser page or the terminal emulator's local scrollback. That does not necessarily tell the agent CLI to scroll its own history.

For full-screen TUIs, older content may not exist as simple terminal scrollback. The app may repaint a selected slice of its internal conversation into the same screen rows rather than append historical lines. If the emulator scrollback is cleared or unavailable, sending TUI scroll commands will not recreate terminal scrollback; it only changes the currently visible TUI viewport.

A mobile web terminal therefore needs an explicit policy:

- For shell-like tabs, finger swipes may scroll terminal scrollback.
- For agent TUI tabs, finger swipes may need to be translated into mouse-wheel or paging escape sequences sent to the PTY.
- If the TUI is in alternate-screen mode, normal terminal scrollback may be intentionally absent.
- A separate transcript view may be better than treating a TUI screen as a log.

## Mouse and touch input

Desktop terminal emulators can translate wheel, mouse, and modifier events into terminal escape sequences. Mobile browsers do not automatically provide equivalent behavior for terminal TUIs.

Difficult cases include:

- translating vertical touch gestures into TUI scroll events
- deciding whether a swipe should scroll the TUI, the terminal scrollback, or the page
- preserving tap-to-focus without triggering accidental keyboard popups after a drag
- supporting selection and copy without breaking TUI mouse tracking
- handling long-press context menus on iOS and Android
- supporting SGR mouse mode and alternate-screen mode only when appropriate

If mouse tracking is disabled or stripped, desktop-like TUI scrolling may stop working. If mouse tracking is enabled unconditionally, ordinary terminal scrollback and touch text selection may become harder.

## Mobile keyboard input

Agent CLIs rely on keys that are awkward or unavailable on mobile software keyboards:

- Escape
- Tab
- Ctrl combinations
- arrow keys
- PageUp/PageDown
- Home/End
- Shift+Enter or custom newline behavior
- bracketed paste boundaries
- Meta/Alt combinations

A practical mobile UI usually needs an auxiliary toolbar for these keys. It also needs careful handling for:

- IME/composition text
- autocorrect and smart punctuation
- multi-character inserts from predictive text
- paste vs typed input
- hidden textareas used to invoke the soft keyboard
- preventing the browser from scrolling the terminal out of view when focusing input

The mobile keyboard also changes viewport size, so input handling and terminal resizing are tightly coupled.

## History replay and reconnect

Persisting or replaying terminal output is harder for TUI agents than for plain shells. Raw PTY output contains cursor movement, screen clears, color/style state, alternate-screen switches, focus reports, mouse-mode toggles, and sometimes content painted for a previous geometry.

Replaying that raw stream into a fresh terminal emulator can be useful for simple shell output, but it is fragile for cursor-heavy TUIs:

- saved output may have been generated at a different width/height
- cursor moves can target rows or columns that no longer exist
- clear-screen operations can erase replayed content
- focus/mouse mode sequences can leave the new terminal in an unexpected state
- very large ANSI histories can hurt mobile performance

More robust approaches include:

- keeping a separate plain-text transcript where possible
- replaying only sanitized/simplified history on mobile
- restoring the live screen by asking the TUI to redraw instead of replaying all raw bytes
- treating raw PTY history and user-facing conversation history as separate artifacts

## Multi-client control

A server-side PTY can have more than one browser client connected. Mobile web makes this especially visible when a desktop client and a phone are attached to the same agent session.

Important questions include:

- Which client controls PTY size?
- Can spectators type, or is input gated to one controller?
- What happens when a mobile client takes control from a desktop-sized session?
- Should non-controlling clients render live TUI output at their own size or at the controller's size?
- How is session state recovered after a browser tab reloads?

For full-screen TUIs, the controller's geometry is usually authoritative. Spectator views at different dimensions may be approximate unless they trigger a takeover and resize/redraw cycle.

## Rendering and font issues

Terminal rendering on mobile web has additional sources of visual mismatch:

- font availability and fallback differences
- emoji presentation vs text presentation
- ambiguous-width Unicode characters
- combining marks and CJK width behavior
- canvas/WebGL texture cache issues
- fractional pixel layout and device pixel ratio
- browser-specific bugs in selection, scrolling, and viewport sizing

A terminal grid is only stable if the emulator's measured cell size matches the actual rendered glyphs. Even small differences can accumulate into wrapping or cursor alignment problems.

## Transport and performance

Interactive agent CLIs are latency-sensitive and output bursty terminal streams. A mobile web bridge must handle:

- WebSocket reconnects
- backpressure during large output bursts
- UTF-8 boundary correctness
- preserving ordering between resize, input, and output events
- throttling expensive rendering on mobile devices
- avoiding unbounded memory growth in history buffers
- recovering cleanly after the browser suspends a background tab

Mobile networks and browser lifecycle behavior make reconnect semantics especially important.

## Process, environment, and credentials

The agent CLI usually runs on a server or desktop host, not on the phone. The web UI is only a remote terminal. That means the host must provide:

- installed CLI binaries
- shell configuration
- authentication state
- model/provider configuration
- repository access
- MCP or tool configuration where applicable
- appropriate environment variables

Security boundaries matter. Browser clients should not receive long-lived secrets unnecessarily. Per-session control tokens, narrow scopes, filesystem permissions, and careful logging are important.

## Practical design implications

A mobile web experience can work well, but it should not assume that a desktop terminal can simply be embedded unchanged. A solid design usually separates concerns:

- **Live TUI view** for current interactive control.
- **Mobile input toolbar** for unavailable keys.
- **Explicit touch policy** for TUI scrolling vs terminal scrollback.
- **Resize/redraw protocol** for takeover and viewport changes.
- **Plain transcript/history view** when historical conversation browsing matters.
- **Reconnect strategy** that restores a clean live screen without blindly replaying incompatible raw TUI output.
- **Per-tab/session control model** for multi-client access.

## Recommended behavior

For agent CLI tabs on mobile web:

1. Treat the agent as a full-screen TUI, not as a plain append-only log.
2. Keep PTY dimensions synchronized with the visible terminal grid.
3. On takeover or major viewport change, trigger a real TUI redraw.
4. Translate finger swipes into TUI scroll input when the TUI owns scrolling.
5. Provide a separate transcript/history surface for reliable retrospective reading.
6. Use terminal scrollback primarily for shell-like output, not as the only history model for agent conversations.
7. Test on real mobile browsers, including soft-keyboard open/close, orientation change, reconnect, and mixed desktop/mobile control.
