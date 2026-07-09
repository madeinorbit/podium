# Soft keyboard profiles — context-aware mobile key toolbar

- **Date:** 2026-06-11
- **Status:** Design — awaiting review
- **Branch:** TBD (feature branch off `main`)

## Summary

On mobile, the key toolbar above the terminal currently renders one fixed set of
keys regardless of what the panel is running. This design makes the toolbar
**context-aware**: it picks a *profile* (a declarative key layout) based on what is
actually running in the panel — Claude Code, Codex, opencode, a shell, or an
unknown TUI — and re-renders live as that changes (e.g. you shell out of Claude into
`vim` and back).

Two halves:

1. **Live foreground detection** — the daemon notices which program is in the
   foreground of a session's PTY and pushes a tiny `sessionForegroundChanged`
   message, mirroring the existing OSC-title push. Detection is pure OS
   process-table inspection; the session backend (today abduco) is touched in
   exactly one small function so it stays swappable.
2. **Declarative profile catalog + interaction engine** — profiles are pure data
   (key labels, sizes, tap bytes, long-press alternates, `⋯` sub-pages). A rewritten
   toolbar renders any profile and implements the universal behaviors (tap,
   long-press popovers, `⋯` sheets, modifier arm/hold/double-tap-lock, the XL arrow
   cluster, newline-without-submit). Adding a new agent's keyboard is a table entry,
   not engine code.

## Why this exists (Podium context)

Podium shows agent terminal sessions in a browser: `xterm.js` + a mobile key
toolbar in `packages/terminal-client` send keystrokes over a WebSocket to
`apps/server`, which writes them into a durable PTY (abduco-backed, via
`@podium/agent-bridge`) running the agent. A phone soft keyboard hides or buries the
keys that matter most for driving a coding agent or shell (Esc, Tab, Ctrl-chords,
arrows, punctuation, mode toggles). The current toolbar
(`packages/terminal-client/src/toolbar.ts`) is a single hardcoded `TOOLBAR_GROUPS`
array with a one-shot Ctrl modifier — useful, but identical in Claude Code, a bash
shell, or a pager, even though each wants a very different set of keys.

The system already knows enough to do better: `AgentKind` (`'claude-code' | 'codex'
| 'shell'`) lives in `@podium/protocol` and every `SessionMeta` carries `agentKind`,
which `AgentPanel.tsx` already has in hand. That gives a free *baseline* profile;
live foreground detection refines it.

## Goals / non-goals

**Goals**
- Per-panel keyboard profile chosen automatically from what's running, refined live.
- Declarative profiles so agents (incl. opencode and future ones) are data entries.
- Full interaction model from the spec: long-press menus, `⋯` overflow sub-pages,
  modifier arm/hold/double-tap-lock, XL arrow cluster, newline-without-submit.
- Manual profile override (pin / Auto) from the `⋯` → Profiles sheet.
- Backend-agnostic detection: no dependency on abduco internals beyond one function.

**Non-goals**
- Making `opencode` (or other not-yet-supported agents) *launchable*. We add its
  profile declaratively, best-effort, **untested against the real CLI** (per user).
- Per-agent behavioral testing of key sequences. We encode to documented standards
  and ship best-effort; tests cover the *mechanism*, not each agent's reaction.
- A desktop/physical-keyboard redesign. This is the mobile accessory bar.

## Component boundaries

Each unit is independently testable and has one job:

| Unit | Location | Responsibility |
|------|----------|----------------|
| Anchor PID resolver | `packages/agent-bridge/src/abduco.ts` | `sessionAnchorPid(label)` → agent PID. **Only** backend-specific piece. |
| Foreground reader | `packages/agent-bridge/src/foreground.ts` | `readForegroundCommand(pid)` → fg command name. Pure OS. |
| Foreground poller + push | `apps/daemon` + `@podium/protocol` | Poll while controlled; emit `sessionForegroundChanged`. |
| Profile catalog | `packages/terminal-client/src/profiles.ts` | The Default/Shell/Claude/Codex/opencode data. |
| Profile resolution | `packages/terminal-client/src/resolve.ts` | `(agentKind, fgCommand, pinned) → Profile`. |
| Interaction engine | `packages/terminal-client/src/toolbar.ts` | Render a profile + run all interaction behaviors. |
| Key encoding | `packages/terminal-client/src/keys.ts` | `encode(modifiers, base) → bytes`. |
| Web wiring | `apps/web` | Feed agentKind + fg command + pin state into the toolbar; render the Profiles sheet. |

## 1. Foreground detection (backend-agnostic)

Runtime detection is pure OS process-table inspection. The session backend is
touched in exactly one small function; nothing else knows abduco exists.

### Anchor PID (the only backend-specific piece)

abduco's session list (`parseAbducoList`) already surfaces, per session, the PID
returned by `forkpty()` in `vendor/abduco/abduco.c` (line 434) — i.e. **the agent
process itself**, the command running on the slave tty (verified against the vendored
source). Add:

```ts
// abduco.ts
export function sessionAnchorPid(label: string): number | undefined
```

a one-line reuse of the existing `listSessions()` lookup. A backend that replaces
abduco implements only this function; detection, protocol, profiles, and toolbar are
untouched. (`node-pty`'s `proc.pid` is the throwaway `abduco -a` attach client and is
**not** usable — it is not on the agent's tty.)

### Foreground reader (pure OS)

```ts
// foreground.ts
export function readForegroundCommand(anchorPid: number): string | undefined
```

- **Linux:** read `/proc/<anchorPid>/stat`, take field `tpgid` (the controlling
  tty's foreground process-group id), then read `/proc/<tpgid>/comm` for the command
  name. If the anchor turns out not to own a controlling tty (a future backend whose
  anchor is a parent wrapper), fall back to the nearest descendant that does.
- **macOS / other:** `ps -o tpgid= -p <anchorPid>` then `ps -o comm= -p <tpgid>`.
- Returns `undefined` on any failure (process gone, no tty, parse miss) — callers
  treat that as "no refinement," falling back to the agentKind baseline.

Parsing note: `/proc/<pid>/stat` field 2 (`comm`) can contain spaces/parens, so split
on the **last** `)` before reading positional fields, per the kernel's documented
format.

### Polling and push

The daemon's session manager owns lifecycle, so it owns the poll. While a session
has a controller attached, poll `readForegroundCommand(sessionAnchorPid(label))` on a
light interval (~750 ms). When the command **changes**, emit:

```ts
// protocol — new ServerMessage member, sibling of SessionTitleChangedMessage
SessionForegroundChangedMessage = {
  type: 'sessionForegroundChanged',
  sessionId: string,
  command: string,   // e.g. 'zsh', 'vim', 'node', 'claude'
}
```

No controller attached → no polling (nobody is looking at the keyboard). The push is
tiny and rate-limited by change, exactly like the title push that already exists for
~10 Hz OSC title churn.

### Resolution

- Launched `agentKind` selects the **baseline** profile.
- The foreground command **refines** it:
  - known shell (`bash`, `zsh`, `fish`, `sh`, `ash`, `dash`) → **Shell**
  - editor/pager/REPL/unknown TUI (`vim`, `nvim`, `vi`, `less`, `more`, `man`,
    `top`, `htop`, `python`, `node` *when the baseline is `shell`*, …) → **Default**
  - a name that maps to an agent (`claude`, `codex`, `opencode`) **or** the baseline
    agent's own runtime while the baseline is that agent → that **agent** profile
- No backend available, or before the first poll → static agentKind profile.

The **agentKind baseline** is what makes node-based agents work: Claude Code and
Codex both often report `node` as the foreground `comm`, which alone can't tell them
apart. The baseline disambiguates ("we launched Claude, fg is still `node` → stay
Claude"); detection's real job is spotting when you've shelled out to something else.

### Manual override

The `⋯` → Profiles sheet lists every profile plus **Auto**. Selecting a profile
**pins** it (detection no longer changes the bar); selecting **Auto** clears the pin
and resumes detection. Pin state is per-session, client-side.

## 2. Declarative profile model

Profiles are pure data in `profiles.ts`. Adding a profile never touches the engine.

```ts
type Sz = 'S' | 'M' | 'L' | 'XL'
type Modifier = 'Ctrl' | 'Shift' | 'Alt' | 'Meta' | 'Fn'

type KeyAction =
  | { t: 'send'; bytes: string }       // raw byte sequence
  | { t: 'mod'; mod: Modifier }        // arm/hold/lock a modifier (see §3)
  | { t: 'menu'; menu: string }        // open a named sub-page (Nav/Edit/Symbols/Profiles/…)
  | { t: 'arrows' }                    // the XL arrow cluster widget

interface KeyDef {
  label: string                        // visible glyph/text
  size: Sz
  title: string                        // tooltip + accessible name (spelled out)
  action: KeyAction
  longPress?: KeyDef[]                 // popover of alternates (each a full KeyDef)
}

interface Menu { id: string; title: string; keys: KeyDef[] }

interface Profile {
  id: string
  name: string
  matches: string[]                    // fg command names that select this profile
  bar: KeyDef[]                        // main row, in [Left | Middle | Right | More] order
  menus: Record<string, Menu>          // sub-pages reachable from ⋯ and long-press
}
```

Structural invariant (enforced by test): every `{ t: 'menu', menu }` action resolves
to a real key in some profile's `menus`.

## 3. Interaction engine (`toolbar.ts` rewrite)

A profile-driven renderer + interaction state machine. Generalizes today's
`mountKeyToolbar`; keeps the `holdFocus` trick (suppress `pointerdown` default so the
soft keyboard doesn't collapse and the xterm textarea keeps focus) and the
`applyModifiers(data)` hook in `session-mount.ts`.

Universal behaviors (from the spec):

| Element | Behavior |
|---------|----------|
| **Layout** | `[Left: raw control] [Middle: profile actions] [Right: nav] [⋯ More]`; S/M/L/XL via CSS classes; `⋯` pinned far right. |
| **Tap** | `conn.sendInput(encode(activeModifiers, action))`. |
| **Long-press** (~400 ms hold) | Popover listing `longPress[]` alternates; tap one to send and dismiss. |
| **⋯** | Bottom sheet whose tabs are the profile's `menus` (Nav, Edit, Symbols, Apps, Profiles, Chat, Model, Tools, Raw, …); each tab a grid of `KeyDef`s. |
| **Modifier** (Ctrl/Shift/Alt-Meta/Fn) | **tap** = arm one-shot, **hold** = chord while pressed, **double-tap** = lock (sticky until tapped again). Active modifiers compose and apply to the next toolbar key *and* the next soft-keyboard character. |
| **Arrow cluster** | One XL widget: tap/hold the four arrows; long-press → PgUp/PgDn/Home/End. |
| **NL** (newline-without-submit) | Default Ctrl+J (`\x0a`); long-press offers Shift/Alt/Ctrl+Enter. |
| **Esc** | Tap = Escape; long-press = Esc / Ctrl+C / `q` / `:q`. |

The modifier engine generalizes the current one-shot `ModifierState`: it tracks a set
of armed + locked modifiers, reflects state on the buttons (`aria-pressed`, `.armed`,
`.locked`), and feeds `encode()`.

## 4. Key encoding (`keys.ts` expansion)

Extend today's special-keys + `ctrlByte` with `encode(modifiers, base)`:

- Ctrl+letter → C0 control byte (existing `ctrlByte`).
- Shift+Tab → CSI Z (`\x1b[Z`, existing).
- Alt/Meta + key → ESC-prefix (`\x1b` + char). Covers Claude's Meta+P/O/T/M and
  opencode `<leader>` combos.
- NL default Ctrl+J = `\x0a`; long-press alternates Shift/Alt/Ctrl+Enter encoded via
  the CSI-u modifyOtherKeys form (`\x1b[13;<mod>u`).
- Paging / edit combos as literal sequences in the catalog: PgUp `\x1b[5~`, PgDn
  `\x1b[6~`, Home `\x1b[H`, End `\x1b[F`, Ctrl+X Ctrl+E `\x18\x05`, etc.

Per the "no need to test the agents" guidance, agent-specific combos are encoded to
the documented standard and shipped best-effort.

## 5. Profile catalog (`profiles.ts`)

Transcribed from the user spec. Sizes: S narrow / M normal / L wide / XL arrow
cluster. Universal long-press behaviors (Esc, Tab, Ctrl, arrows, NL) apply in every
profile.

### Default / fallback
- **Bar:** `Esc(M) Tab(M) Ctrl(L) Mod(M) /(S) -(S) [◀▲▼▶](XL) ⋯(M)`
- **Mod menu:** Shift · Alt/Meta · Cmd/Super · Fn · Lock
- **⋯ pages:** Nav · Edit · Symbols · Apps · Profiles
  - **Nav:** PgUp · PgDn · Home · End · Del · Ins · F1–F12
  - **Edit:** Ctrl+C · Ctrl+D · Ctrl+R · Ctrl+L · Ctrl+A · Ctrl+E · Ctrl+U · Ctrl+K ·
    Ctrl+W · Ctrl+Y
  - **Symbols:** `./` · `../` · `~/` · `|` · `&&` · `||` · `>` · `>>` · `<` · `$` ·
    `*` · `?` · `"` · `'` · `\` · `;`
  - **Apps:** quick-launchers (type `vim`/`less`/`htop`/… + Enter). **Assumption** —
    spec listed "Apps" without contents; revisit if a different meaning was intended.
  - **Profiles:** Auto + one entry per profile (manual pin, §1).

### Shell (bash/zsh/fish, SSH, package managers, Docker, Git)
- **Bar:** `Esc(M) Tab(M) Ctrl(L) Alt(L) /(S) -(S) |(S) [◀▲▼▶](XL) ⋯(M)`
- **Long-press `/`:** `/` `./` `../` `~/` `~` `.` `..`
- **Long-press `-`:** `-` `--` `_` `--help` `-la` `-R` (no dangerous `-rf` default)
- **Long-press `|`:** `|` `&&` `||` `>` `>>` `<` `2>` `2>&1` `&` `;`
- **Ctrl menu:** Stop(^C) · EOF(^D) · Suspend(^Z) · Search(^R) · Clear(^L) · Start(^A)
  · End(^E) · Kill←(^U) · Kill→(^K) · KillWord(^W) · Yank(^Y) · Editor(^X^E)
- **Alt menu:** Word←(⌥B) · Word→(⌥F) · DelWord→(⌥D) · DelWord←(⌥⌫) · LastArg(⌥.)
- **⋯ pages:** Edit · Nav · Symbols · Jobs · Snippets
  - **Snippets:** `sudo ` · `cd ` · `ls -la` · `grep ` · `find . -name ` · `chmod +x `
    · `./` · `~/.ssh/`

### Claude Code
- **Bar:** `Esc(M) Tab(M) Ctrl(L) Mode(M) Model(M) NL(M) [◀▲▼▶](XL) ⋯(M)`
- **Main actions:** Mode → Shift+Tab · Model → Meta+P · NL → Ctrl+J · Esc → Esc
  (long-press Ctrl+C) · Ctrl → raw chord
- **Long-press Mode:** Shift+Tab · Meta+M
- **Long-press Model:** Model Picker (Meta+P) · Fast Mode (Meta+O) · Thinking (Meta+T)
- **⋯ pages:** Chat · Model · Tools · Nav · Raw
  - **Chat:** Stop(^C) · Clear(^L) · History(^R) · Stash(^S) · Editor(^G)
  - **Model:** Model(Meta+P) · Fast(Meta+O) · Thinking(Meta+T) · Cycle Mode(Shift+Tab)
  - **Tools:** Transcript(^O) · Task List(^T) · Kill Agents(^X^K) · Leader(^X)

### Codex CLI
- **Bar:** `Esc(M) Tab(M) Ctrl(L) NL(M) Hist(M) Reason(L) [◀▲▼▶](XL) ⋯(M)`
- **Main actions:** Esc → interrupt turn · Tab → queue/autocomplete · NL → Ctrl+J ·
  Hist → Ctrl+R · Reason → mini menu · Ctrl → raw chord
- **Reason mini menu:** Reason−(⌥,) · Reason+(⌥.)
- **⋯ pages:** Prompt · Output · Approval · Nav · Raw
  - **Prompt:** Clear(^L) · Editor(^G) · History↑(^R) · History↓(^S) · Keymap (insert `/keymap`)
  - **Output:** Transcript(^T) · Copy Output(^O) · Raw Output(⌥R)
  - **Approval:** Approve(`y`) · Session(`a`) · Prefix(`p`) · Deny(`d`) · Cancel(`c`) ·
    Thread(`o`) · Fullscreen(^A)

### opencode (best-effort, untested)
- **Bar:** `Esc(M) Tab(M) Ctrl(L) Leader(L) Model(M) NL(M) [◀▲▼▶](XL) ⋯(M)`
- **Main actions:** Leader → Ctrl+X · Model → `<leader>m` (Ctrl+X then `m`) · NL →
  Ctrl+J (configurable) · Tab → cycle agent · Shift+Tab → reverse cycle · Esc →
  interrupt
- **Long-press / ⋯ pages:** the user spec was **cut off** here. We fill with
  sensible defaults (a Leader sub-page exposing common `<leader>` combos, plus
  Nav/Raw) and **flag every opencode menu as an assumption** to confirm later.
- Add `'opencode'` to the `AgentKind` enum so the profile is selectable once opencode
  becomes a launchable agent. Launching it is out of scope.

## 6. Web wiring (`apps/web`)

`AgentPanel.tsx` already holds `session.agentKind`. Changes:
- Surface the latest `sessionForegroundChanged.command` per session in the store
  (`store.tsx`), keyed by `sessionId`, alongside the existing title state.
- Pass `agentKind` + the live `foregroundCommand` + the per-session pin into
  `mountSession`/`mountKeyToolbar`. The toolbar re-runs `resolveProfile` and
  re-renders on any change.
- The `⋯` → Profiles sheet drives the pin (Auto clears it).

## 7. Testing (mechanism, not agents)

Per the user's guidance — unit tests for the machinery, none against live agent CLIs:
- `foreground.ts`: `/proc/<pid>/stat` tpgid parsing (incl. `comm` with spaces/parens)
  and `ps` fallback parsing, from fixtures.
- `abduco.ts`: `sessionAnchorPid` over a `parseAbducoList` fixture.
- `keys.ts`: `encode()` for each modifier combination.
- modifier state machine: arm / hold / double-tap-lock transitions and composition.
- `resolve.ts`: agentKind baseline + fg refinement + pin override matrix.
- catalog: structural validation (every `menu` action resolves to a real sub-page;
  every `send` is non-empty).

## Assumptions / open items

1. **agentKind baseline kept** — required for node-based agent disambiguation.
2. **"Apps" sub-page = quick-launchers** — spec listed the tab without contents.
3. **opencode menus are best-effort placeholders** — spec was truncated; untested.
4. **Modifier encodings** (CSI-u for modified Enter, ESC-prefix for Alt/Meta) are the
   documented standards, shipped best-effort and not validated per agent.
5. Poll interval (~750 ms) and long-press threshold (~400 ms) are starting values,
   tunable after dogfooding.

## Out of scope (future)

- Making opencode and other agents launchable.
- Per-agent validation of key sequences against the real CLIs.
- An editor/pager-specific profile (handled by Default for now).
- Physical-keyboard / desktop layouts.
