# Dev builds in low-priority units — verification

Landed on main as `9a53905ab` (commits `1789f7c6c`, `9a53905ab`). All measurements on
**ludovico**, 8 cores, systemd 255, 2026-08-13.

## What changed

| | Before | After |
|---|---|---|
| Headless bundle build | plain child of `podium-server.service` → CPUWeight **900**, IOWeight 500, no quota | `podium-dev-bundle-build.scope`, CPUWeight **50**, CPUQuota **200%** |
| Web + mobile build | `podium-web.service`, systemd default CPUWeight **100**, no quota | `podium-dev-web-build.scope` + `podium-dev-mobile-build.scope`, same tier |
| Who owns the web build | a separate unit nothing sequenced against | a step the server runs before the compile that requires it |
| Web-dist precondition | checked **after** the abduco prebuild and `bun build --compile` | checked first, before anything expensive |

An agent session scope is CPUWeight=50 / IOWeight=100, so the builds now sit at the agent
tier rather than eighteen times above it.

## Scope, not service — decided on evidence

Both a transient scope and a transient service put the build in a **sibling** cgroup, so
either takes it out of `podium-server.service`. The deciding question was what a server
restart does to an in-flight build. Measured, by running a scope from inside a throwaway
service and restarting that service: **the build survives**, reparented to the user
manager, scope still `active`. A transient service survives too — so survival did not
separate them.

What did: `--scope` execs the command in place, so the build stays a real child of the
server. Measured — `sh -c 'exit 7'` through a scope returns **7**, and stdout is inherited,
which keeps build output in the server's journal. A transient service needs `--wait` to
report status at all.

Because the orphan survives, the unit name is deterministic and **every launch reclaims it
first** (`stop` + `reset-failed`). Otherwise the next server would compile concurrently with
the orphan, and two `build-bun.ts` runs share `dist-bun/podium` and `dist-bun/headless/` —
one build's tarball could carry the other's binary. Measured: a second `systemd-run` at a
live name exits 1; after the reclaim it exits 0, and the orphan process is gone.

## The tier took effect (not just "was passed")

Live capture during the real build at 13:15:57, after restarting `podium-server.service`
onto the landed code:

```
podium-dev-web-build.scope     cpu.weight=50  cpu.max=200000 100000
podium-dev-mobile-build.scope  cpu.weight=50  cpu.max=200000 100000
podium-dev-bundle-build.scope  cpu.weight=50  cpu.max=200000 100000
```

```
--- processes in podium-dev-bundle-build.scope ---
  pid 3648498: /home/mgw/.local/bin/bun scripts/build-bun.ts
  pid 3648646: tar -czf .../podium-headless-dev+9a53905-20260813T111644Z.tar.gz
--- processes in podium-server.service ---
  pid 3645292: /home/mgw/.local/bin/bun --conditions=@podium/source scripts/server.ts
```

`podium-server.service` held **exactly one** pid — the server itself — for the whole of all
three builds. For comparison its own `cpu.weight` reads **900**.

The chain web → mobile → bundle completed in ~56 s and published `dev+9a53905`, a 50.0 MB
signed tarball; `apps/web/dist` stamped `9a53905`.

## IOWeight is inert on this host — stated honestly

`systemctl --user show` reports `IOWeight=50`, but the user manager is delegated
`cpu memory pids` only (`systemctl show user@1000.service -p DelegateControllers`), so **no
`io.weight` file exists for any `--user` unit** — `podium-server.service`'s `IOWeight=500`
and the agent scopes' `IOWeight=100` included. It is set anyway: it costs nothing and starts
working the day `io` is delegated.

## The fallback works

The build must still run where `systemd-run` cannot create a scope. Proven twice, both
exit 0 with the build completed unscoped:

- `systemd-run` removed from `PATH` (stands in for macOS / Windows / a non-systemd host)
- `PODIUM_NO_SCOPE=1` (the documented escape hatch)

## The race that is gone

The compile refuses a `dev+<sha>` tarball whose web half came from another commit, and
producing that dist belonged to a separate unit. 28 of 112 attempts in the week to
2026-08-13 were refused there, and because `/version` re-asks every 60 s a stale dist spun
the loop — 29 attempts in one hour. Sequencing the web build makes the precondition the
build's own first step. The sequencing waits on each build **process exit**, not on the
stamp (POD-1986: the stamp is written third-from-last, so it can read HEAD over an
unfinished dist); the stamp is only used for the cheap "already current, do nothing" skip.

And the refusal, when it does happen, is now free: a missing `apps/web/dist` fails before
the `[build-bun] prebuilding abduco` line instead of after a full compile.

## Gates

- `bun run test` — typecheck 24/24, boot-wiring probe 72 passed
- `scripts/systemd-diff.ts` — 11 generated dev-host files match
- updates module + `cli-systemd` + `build-bun` suites — 284 passed
- `lint:boundaries` — 3 violations, byte-identical to `main` at `5aa8cfdd5`, none in files
  touched here

## Host state after landing

`podium-redeploy.path` is **disabled and inactive** on ludovico, so a main move does not
auto-redeploy here; `podium-server.service` was restarted by hand to pick this up.

Installed units had drifted from the renderer well before this change. Done, with the
human's agreement:

- installed the rendered `podium-redeploy.service` (the installed one predated the janitor
  restart and still named `podium-web.service`)
- `systemctl --user disable --now podium-web.service`

Any **other** dev host still has the old `podium-web.service` and the old redeploy unit, and
needs the same two steps.
