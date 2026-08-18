# Native harness discovery verification

Date: 2026-08-18

## Repository gate

`bun run test` passed after worktree workspace links were installed:

- 24/24 typecheck tasks passed.
- 4/4 boot-lane files passed.
- 73/73 boot-lane tests passed.

## Linux container acceptance

Command: `./scripts/harness-environment-container-smoke.sh`

Both containers started with parent `PATH=/usr/bin:/bin` and `PODIUM_DESKTOP_SUPERVISED=1`. Fake harnesses existed only under `/opt/podium-harness-bin`, exported by the passwd account's login profile.

| Image | Login shell | Environment source | Result |
| --- | --- | --- | --- |
| `oven/bun:1-debian` | `/bin/bash` | `login-shell` | Pass |
| `oven/bun:1-alpine` | `/bin/ash` | `login-shell` | Pass |

Both resolved and launched these exact paths with `/opt/podium-harness-bin` first in the effective PATH:

- Claude Code: `/opt/podium-harness-bin/claude`
- Codex: `/opt/podium-harness-bin/codex`
- Grok: `/opt/podium-harness-bin/grok`
- OpenCode: `/opt/podium-harness-bin/opencode`
- Cursor: `/opt/podium-harness-bin/agent`

The first Debian run exposed that Bun can report `os.userInfo().shell` as the literal string `unknown` in a minimal container. Production fallback now rejects unusable account-shell values and continues to `SHELL`, then the platform default. The repeated Debian/bash and Alpine/ash runs both passed.

## Remaining platform acceptance

Linux containers prove shell recovery, verification-to-launch identity, and interpreter PATH propagation. They cannot prove the macOS Finder/launchd boundary. Release acceptance still requires one Finder launch where launchd lacks Homebrew's prefix and a Homebrew-installed Claude or Codex is inventoried and started successfully.
