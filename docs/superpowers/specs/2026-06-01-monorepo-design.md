# Podium Monorepo — Architecture & Skeleton Design

- **Date:** 2026-06-01
- **Status:** Approved (design) → ready for implementation plan
- **Scope:** The monorepo *skeleton* and the "what goes where" map. **Not** the product features.

---

## 1. What this spec covers (and what it does not)

This spec defines the structure, tooling, and documentation of the Podium monorepo so
that future feature work has clear homes. It explicitly does **not** design the product
itself.

**Built now:** workspace + tooling configuration, the package/app directory layout, one
purpose-stating `README.md` per package, and an `ARCHITECTURE.md` that is the source of
truth for the "what goes where" map.

**Not built now:** feature code or stubbed functions inside packages. Each package gets
a real `package.json` and config but an empty `src/` (at most a single doc comment).
This honors the instruction to set up and document the monorepo without building or
stubbing the app.

---

## 2. Background (product vision, for context only)

Podium is an agent-orchestration app for driving coding agents (Claude Code, Codex CLI)
from a best-in-class web + mobile experience, with mobile as a first-class citizen. The
intended runtime topology:

- a **server** (API / web backend) that can live apart from dev machines,
- a **daemon** installed on each dev machine (macOS laptop, Linux VPS, …) that wraps the
  native agent CLIs over a PTY (tmux-style — no `claude -p` abstractions), and
- (later) cloud sandboxes for agents.

Two pieces are intended to be released as **standalone open-source libraries**:

1. a **wrapper for coding-agent CLIs** — spawn/attach the process, listen to output,
   inject input, manage geometry and multi-client control; and
2. a **browser presentation client** for agent terminal sessions on web and mobile
   (including the same session on two clients at once) with first-class controls
   (scrollback, keyboard shortcuts, touch).

The hard constraints driving the split live in
[`docs/mobile-web-agent-cli-challenges.md`](../../mobile-web-agent-cli-challenges.md):
terminal geometry/redraw, scrollback vs TUI scrolling, mobile keyboard/touch input,
history replay on reconnect, and multi-client control. Those concerns map directly onto
the `protocol`, `agent-bridge`, and `terminal-client` packages below.

---

## 3. Key decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| Package manager + workspaces | **Bun 1.3** workspaces | Already installed; fastest install/test; single toolchain. |
| Server/daemon **runtime** | **Node** (via `tsx` in dev) | `node-pty` is a native N-API addon that is most reliable on Node. Bun stays the package manager / task runner / bundler; the PTY-touching processes run under Node. |
| Client strategy | **Web-first responsive** (React + Vite) now; native later | Mobile is first-class via mobile web today; `terminal-client` core kept framework-agnostic so a later Expo/Tauri app reuses it. |
| Server↔client API | **Hono + tRPC** | End-to-end TS types. `AppRouter` type is exported from `apps/server` and imported **type-only** by `apps/web`; shared zod schemas live in `@podium/core`. |
| Package decomposition | **Approach A** — two libs + shared protocol | Independent release cadence; Node-only and browser-only code never cohabit; the wire protocol becomes a first-class artifact. |
| Lint + format | **Biome** | One fast tool; fits the Bun/fast-DX ethos. |
| Test runner | **Vitest** | One story across node + browser-ish packages; jsdom for `terminal-client`. |
| Library build | **tsup** | Emits ESM + `.d.ts` in one step for the published packages. |
| Versioning / release | **Changesets** | Independent semver for each published package. |
| Typecheck | **TS project references** | Fast, incremental, enforces dependency direction. |
| Task running | **`bun run --filter`** | No extra orchestrator now. Turborepo can be layered on later for caching. |
| Module format | **ESM-only**, `"type": "module"` | Modern target for all packages. |
| npm scope | **`@podium/*`** | Published libs are public; internal packages are `"private": true`. |

Package names (`agent-bridge`, etc.) are a bikeshed and trivially renameable before first
publish.

---

## 4. Package & app inventory

### Apps (created now; not published)

| Path | Runtime | Purpose | Depends on |
|------|---------|---------|------------|
| `apps/server` | Node | Hono + tRPC API / web backend. Auth, persistence, conversation index, fans out to daemons. Exports `AppRouter` type. | `@podium/core`, `@podium/protocol` |
| `apps/daemon` | Node | Installed per dev machine. Spawns/attaches agent CLIs via `@podium/agent-bridge`; harness/project/worktree discovery; connects to `server`. | `@podium/agent-bridge`, `@podium/protocol`, `@podium/core` |
| `apps/web` | Browser (Vite) | Responsive web UI (command center, product/spec modes). Renders live agent terminals. | `@podium/terminal-client`, `@podium/core`, `type AppRouter` from `apps/server` |

### Packages

| Name | Path | Published | Env | Purpose | Depends on |
|------|------|-----------|-----|---------|------------|
| `@podium/protocol` | `packages/protocol` | ★ yes | isomorphic | Wire types for agent/terminal sessions: output frames, input events, resize, takeover/multi-client, lifecycle, transcript. Tiny, dependency-light (zod only). | — |
| `@podium/agent-bridge` | `packages/agent-bridge` | ★ yes | Node | **The coding-agent wrapper.** PTY/tmux spawn + attach, `SIGWINCH`/resize, output stream, input injection, redraw protocol, controller/spectator multi-client, transcript extraction, CLI discovery (Claude/Codex). | `@podium/protocol` |
| `@podium/terminal-client` | `packages/terminal-client` | ★ yes | Browser | **The browser presentation client.** xterm.js wrapper, touch/scroll policy, mobile key toolbar, reconnect/backpressure, multi-client render, transcript view. Framework-agnostic core. | `@podium/protocol` |
| `@podium/core` | `packages/core` | no | isomorphic | Internal domain model + zod schemas (Project, Repo, Worktree, Session, Stream, Task, AgentKind, Machine, …). | — |

### Tooling

| Path | Purpose |
|------|---------|
| `tooling/tsconfig` | Shared TS base configs (`base`, `library`, `node`, `react`) that packages/apps extend. |

★ `protocol` is published because the two public libraries depend on it.

---

## 5. Dependency direction

```
apps/web ────────────► @podium/terminal-client ──┐
apps/web ··type-only··► apps/server               │
apps/server ─────────► @podium/core               ├─► @podium/protocol
apps/daemon ─────────► @podium/agent-bridge ──────┘
apps/{server,daemon} ► @podium/core
```

Rules (enforced by TS project references + Biome import rules where practical):

- **Apps depend on packages, never the reverse.**
- **No app → app runtime dependency.** `apps/web` may import only the *type* of
  `AppRouter` from `apps/server`.
- `@podium/protocol` and `@podium/core` depend on nothing internal (leaf packages).
- `agent-bridge` (Node) and `terminal-client` (browser) both depend on `protocol` and
  **never on each other** — that separation is the whole point of Approach A.

---

## 6. "What goes where" map (the documentation deliverable)

| If you're working on… | It lives in… |
|------------------------|--------------|
| Spawning a PTY / tmux, attaching, resizing, killing an agent process | `@podium/agent-bridge` |
| Discovering installed harnesses, recent conversations, projects/worktrees | `@podium/agent-bridge` (discovery module), orchestrated by `apps/daemon` |
| Message types flowing browser ↔ server/daemon (input, output frame, resize, takeover, transcript) | `@podium/protocol` |
| xterm.js rendering, mobile key toolbar, touch/scroll policy, reconnect | `@podium/terminal-client` |
| Domain entities + zod schemas (Project, Stream, Task, Session…) | `@podium/core` |
| tRPC routers, auth, persistence, conversation index, daemon fan-out | `apps/server` |
| React screens, command-center grid, product/spec/dev modes | `apps/web` |
| Per-machine agent lifecycle + discovery orchestration + server connection | `apps/daemon` |
| Shared TS config | `tooling/tsconfig` |
| Architecture / design docs | `docs/` |

---

## 7. Created now vs. documented-as-future

**Created now:** `apps/{web,server,daemon}`, `packages/{protocol,agent-bridge,terminal-client,core}`,
`tooling/tsconfig`, root config + docs.

**Documented in `ARCHITECTURE.md` only (not scaffolded):**

- `apps/mobile` — Expo / React Native (+ RN Web) native client.
- `apps/desktop` — Tauri desktop shell.
- Cloud-sandbox orchestrator service (agents in remote sandboxes).
- `@podium/ui` — shared design-system/component library (once web + native both consume it).
- `@podium/terminal-client-react` — React adapter split out of `terminal-client`.
- `@podium/conversation-index` — hybrid search over indexed sessions.
- Turborepo task caching; CI pipeline.

These are named so contributors know the intended growth path without premature scaffolding.

---

## 8. Tooling baseline

**Root files:** `package.json` (workspaces: `apps/*`, `packages/*`, `tooling/*`),
`bunfig.toml`, `tsconfig.base.json`, `tsconfig.json` (solution-style project references),
`biome.json`, `.changeset/config.json`, `.gitignore`, `.nvmrc` (Node 22), `README.md`,
`CONTRIBUTING.md`, `ARCHITECTURE.md`.

**Root scripts (run via Bun):** `dev`, `build`, `test`, `typecheck`, `lint`, `format`,
`changeset`, `release`. Cross-workspace fan-out uses `bun run --filter '*' <script>`.

**Per published package:** `src/` (empty for now), `package.json` with `exports`,
`"type": "module"`, `tsup.config.ts` (ESM + `.d.ts` → `dist/`), `tsconfig.json` extending
`tooling/tsconfig/library.json`, `README.md`. Internal packages/apps omit `tsup` and set
`"private": true`.

**Conventions:** ESM-only; `@podium/*` scope; published packages carry `repository`,
`license`, `files`, and `publishConfig.access: public`; internal packages set
`"private": true`.

---

## 9. Non-goals

- No feature implementation, auth implementation, or database selection (server
  persistence is a later product decision).
- No native apps, no cloud sandboxes, no CI pipeline in this pass.
- No Turborepo yet (Bun filtering is enough until caching matters).

---

## 10. Success criteria for the skeleton

1. `bun install` resolves the workspace with no errors.
2. `bun run --filter '*' typecheck` passes against the empty packages.
3. Each ★ published library builds via `tsup` to `dist/` with `.d.ts` emitted.
4. `biome check .` passes.
5. Changesets is initialized (`.changeset/config.json` present, release scripts wired).
6. `ARCHITECTURE.md` documents the §6 map; every package has a purpose `README.md`.
7. `README.md` (repo intro) and `CONTRIBUTING.md` (how to install/build/test/add a package) exist.

---

## 11. Open questions / bikeshed (resolved with defaults)

- **Library names** — defaulting to `agent-bridge`, `terminal-client`, `protocol`,
  `core`. Renameable before first publish.
- **React adapter location** — starts inside `terminal-client` (framework-agnostic core +
  optional `/react` subpath); promoted to its own package only when a second framework or
  native client appears.
