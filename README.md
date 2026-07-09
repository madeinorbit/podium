# Podium

**Mission control for coding agents.** Run Claude Code, Codex, and other agent CLIs on your own machines and drive them from a fast web UI — on your desk or from your phone.

Podium wraps the *real* agent CLIs in real PTYs (tmux-style, no `-p` flag abstractions), keeps sessions alive across disconnects and restarts, and adds the coordination layer that turns a pile of terminals into a workflow: a native issue tracker agents can drive themselves, git-worktree-aware session grouping, multi-machine support, and signed self-updates.

- **Real terminals, remotely.** Every agent runs in a persistent PTY session on your machine. Attach from any browser; nothing dies when you close the tab.
- **Mobile first-class.** The web UI is a PWA built to run agents from a phone: check on a long task, answer an agent's question, kick off the next one.
- **Agents that track their own work.** A built-in Linear-style issue tracker with a CLI/MCP surface agents use directly — they claim issues, file discovered work, and report progress while you watch the board.
- **Worktree-native.** Sessions group by git worktree; parallel feature work across worktrees is the default workflow, not a hack.
- **Multi-machine.** One server, many daemons: pair a VPS or a second workstation with a code and start agents on whichever machine has the repo.
- **Self-hosted, single binary.** A compiled Bun binary for the headless server/daemon, plus an optional Tauri desktop app. Your code and your agent credentials stay on your machines.

## Install

Prebuilt headless bundle (linux-x64 today; more platforms on the way). The installer downloads the bundle, **verifies its Ed25519 signature**, and drops `podium` into `~/.local/bin`:

```bash
curl -fsSL https://github.com/madeinorbit/podium/releases/download/edge/install.sh | sh -s -- --channel edge
```

Then run `podium` and finish setup in the browser at the printed URL (or `podium setup` for the terminal flow). To reach the instance from other devices and pair extra machines, see **[docs/adding-a-machine.md](docs/adding-a-machine.md)**.

Release artifacts ship with a `SHA256SUMS` file — verify a manual download with `sha256sum -c SHA256SUMS --ignore-missing`. Updates are applied by `podium update` (or the bundled auto-update timer) and are signature-checked before the install is swapped. Podium is pre-1.0: the `edge` channel tracks `main`; tagged stable releases will follow.

## Run from source

```bash
bun install
bun run host       # web UI + backend (server + daemon) from source
```

Open **http://localhost:55556** (Vite dev server, proxying to the backend on `:18787`). On first load, pick a folder and scan it for git repositories.

Requires **Bun ≥ 1.3.14** — package manager, task runner, bundler, *and* runtime. Node is not required to *run* the app: the agent bridge uses `Bun.Terminal` for PTYs and only falls back to `node-pty` under a Node dev entrypoint. Running the *test suite* DOES require a real **Node ≥ 22** (see Testing below). On macOS, install the Xcode Command Line Tools (`xcode-select --install`) — a C compiler builds the bundled `abduco` session helper on first run.

Contributor checks (see [CONTRIBUTING.md](./CONTRIBUTING.md)):

```bash
bun run typecheck
bun run lint
bun run test
```

### Web version (browser / mobile)

All-in-one — server + daemon in one process, serving the built web UI:

```bash
bun run --filter @podium/web build              # build the web bundle the server serves
bun --conditions=@podium/source scripts/cli.ts  # server + daemon on http://localhost:18787
```

Open <http://localhost:18787> — on a phone, point the browser at the same host (or add it to your home screen as a PWA).

### Desktop version (Tauri)

A native window that spawns the compiled backend and serves the same web UI locally. Requires the Rust + Tauri toolchain:

```bash
bun run --cwd apps/desktop dev      # dev: stage the compiled backend + web, open the window
bun run --cwd apps/desktop build    # release build
```

## Testing

The whole suite runs with one command from the repo root:

```bash
bun run test    # vitest (all workspaces, web under happy-dom) + the bun-only suites
```

Prerequisites: **Bun ≥ 1.3.14** and a real **Node ≥ 22** on PATH. Vitest runs under Node —
do NOT symlink `node` → `bun`; Bun's Node shim breaks vitest's CJS interop (symptoms:
`z.string is not a function`, `DOMPurify.sanitize is undefined`, `document is not defined`
across hundreds of files).

Some tests self-skip when their machine setup is absent (they never fail for it):

- `apps/cli/src/podium-update.test.ts` swap tests — need the operator's signing key
  (`apps/cli/src/.podium-update-dev.key`, the private half of `PODIUM_UPDATE_PUBKEY`).
- `packages/agent-bridge/test/pty-behavior/claude-smoke.test.ts` — needs `claude` on PATH
  with `$HOME` already trusted (run `claude` once in `$HOME` and accept the prompt), or
  set `PODIUM_SKIP_CLAUDE_SMOKE=1`.
- `packages/agent-bridge/src/opencode/*` detection tests expect the `opencode` CLI at
  `~/.opencode/bin/opencode`.

Browser E2E (Playwright, headless Chromium; builds protocol + web, then boots the real
relay/daemon harness):

```bash
bunx playwright install chromium         # once per machine
cd tests/e2e && NODE_OPTIONS="--conditions=@podium/source" bunx playwright test --project=chromium-desktop
```

The `NODE_OPTIONS` condition is required so Playwright's loader resolves workspace
packages from source instead of (possibly unbuilt) `dist/`.

## Security model

Read this before exposing a Podium instance to anything but yourself.

- **Agents execute real shell commands.** A Podium session is a genuine terminal on the host — anyone who can reach your Podium UI can do what a local shell user can do. Only connect machines and repositories you trust, and only share access with people you'd give a shell to.
- **Loopback by default.** The server binds locally. The recommended way to reach it remotely is an authenticated overlay or tunnel (e.g. Tailscale) rather than a public bind.
- **Set `PODIUM_PASSWORD` for any non-loopback bind.** The server warns — but stays up — if exposed without a password; setup flows treat the passwordless option as an explicit, confirmed opt-in. Treat a passwordless non-loopback bind as unsafe unless the network itself is trusted.
- **Signed updates.** Headless update tarballs are Ed25519-signed and verified against the pinned public key before anything is swapped; the desktop app uses Tauri's updater signing separately.

Found a vulnerability? Please report it privately — see [SECURITY.md](./SECURITY.md).

## Repository layout

| Path | What it is |
|------|------------|
| `apps/server` | API / web backend (Hono + tRPC). |
| `apps/daemon` | Per-machine agent host; wraps agent CLIs via `@podium/agent-bridge`. |
| `apps/cli` | The `podium` CLI (setup, update, issue/spec tooling). |
| `apps/web` | Responsive web UI (React + Vite, PWA). |
| `apps/desktop` | Tauri shell around the compiled backend + web UI. |
| `packages/protocol` | Shared agent/terminal wire protocol. |
| `packages/agent-bridge` | Coding-agent CLI process wrapper (server-side PTY). |
| `packages/terminal-client` | Browser terminal presentation client. |
| `packages/domain` | Pure domain logic (issue stages, authz, identity predicates). |
| `packages/runtime` | Runtime plumbing: config, sqlite, git identity, auth. |

The `@podium/*` packages are consumed in-repo and are **not published to npm** (yet). See `ARCHITECTURE.md` for what-goes-where.

## License

[Apache License 2.0](./LICENSE). © 2026 Michael Wirth and the Podium contributors. Third-party licenses are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
