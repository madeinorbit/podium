# Testing the installer against the dev channel

> Historical scenario notes from September–October 2026. Builds, UI wording and box
> assignments below describe that run, not the current fleet. Start with [README.md](README.md),
> claim your slots and use the release issue's selected build and test credentials.

The dev channel is live: `https://github.com/madeinorbit/podium/releases/download/dev/`.
Public, anonymous, signed. Assets sit alongside the desktop dev shell that already lived on
that tag; the filenames are disjoint and nothing was overwritten.

Boxes are `vps1`..`vps5` on `127.0.0.1:2201..2205`, your ssh key installed. `vps5` has no
curl and no wget, for the bare-distro path.

## The one-liner

    ./lab ssh 1 root          # or ./lab ssh 1 for the sudo-user path

    curl -fsSL https://github.com/madeinorbit/podium/releases/download/dev/install.sh | sh -s -- --channel dev

The piped form is fine and prompts normally. `install.sh` probes `/dev/tty` and reconnects it
for the handoff (`install.sh:279`), the same redirect rustup and determinate-nix use, so
piping costs you nothing. With no controlling terminal at all — a CI runner, `ssh` without
`-t` — it passes `--no-interactive` instead of hanging on a prompt nobody can answer.

So `ssh` into a box and paste. Do NOT drive it with `ssh <box> '<command>'`, which allocates
no terminal and will silently take the non-interactive path.

## Joining an existing server

Both directions work now that a dev server hands out a dev join command:

- **vps1 as the server.** Install on vps1, choose "Set up a hub for your other machines",
  then add a machine and paste its command into vps2/3/4. The boxes reach each other by name.
- **An existing server outside the lab.** Add a machine there and paste. It will say
  `--channel dev` by itself — `buildJoinCommand` used to collapse dev to edge, which is what
  made you edit the line by hand.

## Reset between runs

    ./lab snapshot 3 clean     # once, on a box you have not installed on
    ./lab reset 3 clean        # ~2s, as many times as you like

vps1 and vps2 already have a `clean` snapshot and have been reset to it.

## What this build is

Cut by hand from **dev/mw tip `67e96fdcd`** (2026-09-19) and published to the `dev` tag by
`release.ts`. The automated publish is still blocked by POD-3775, so the assets came from the
cross-build job's own artifacts — the same bytes CI built and smoke-tested.

## What has been proven

On a stock Ubuntu 24.04 box with systemd as PID 1, from the real GitHub dev URL:

- signature verified, instance installed, PATH persisted
- the embedded abduco materialized (`/root/.podium/bin/abduco`) — note there is no
  `podium-host` beside it, and that is expected: `build-bun.ts:602` embeds an EMPTY host
  placeholder for every cross target, and every release bundle is cross-built
- no `machine.key` yet at install time — the keypair is minted by setup/join, not by the
  installer, which is why the installer needed no change for the new machine identity
- `podium --version` → `0.1.1-edge.4`, `podium channel` → `dev`
- with a terminal, the clack flow reaches the mode-first select with its hints — including
  under `curl … | sh`, via the `/dev/tty` reconnect
- with no terminal, it takes the non-interactive path and closes with the boxed commands

Not yet walked by hand: the join paths, `--instance`, `--vps`, `--agents`, re-install over a
configured box, and the bare-distro path on vps5.
