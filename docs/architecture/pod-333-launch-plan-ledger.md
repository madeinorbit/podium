# CLI launch plan — variants, resolver, and the config version that removed two of them

**Owner:** POD-333 (Phase 7.1) · **Subject:** `apps/cli/src/cli.ts` `LaunchPlan` +
`resolvePlan`, and `packages/runtime/src/config.ts` `CONFIG_MIGRATIONS`.

## Why this ledger exists

`resolvePlan` is the one place that turns `(config, argv, env, tty)` into a
decision, and the value of that shape is that the whole combinatorial matrix is
unit-testable without spawning anything. That property degrades quietly: every
variant added for a *config-shape* reason rather than a *launch* reason makes the
matrix bigger while telling a reader less, because they now have to know the
history of `config.json` to know which branches can still happen.

Two such variants had accumulated. This file records the count, the resolver's
decision order, and the migration that let both go — so the next person adding a
variant can see whether theirs is a launch mode or a migration in disguise.

## The count

**34 variants**, all of them real (`podium help`, `podium issue …`, `podium
status`, the four launch modes, and so on). The full list, in declaration order:

`help`, `approval-request`, `approval-status`, `version`, `update`, `channel`,
`telemetry`, `quota`, `machine`, `join-config`, `set-server`, `janitor`,
`repair-config`, `join-setup`, `issue`, `session`, `mail`, `offer`, `agent`,
`spec`, `worktree`, `workspace`, `lock`, `workflow`, `merge-lock`, `status`,
`stop`, `logs`, `usage-error`, `interactive-setup`, `client`, `systemd-managed`,
`detached-managed`, `in-process`.

Twenty-nine of those are utility subcommands and argv errors, folded in so
`main()` needs no dispatch of its own. **Five are launch decisions**:
`interactive-setup`, `client`, `systemd-managed`, `detached-managed`,
`in-process`.

`repair-config` is on the list and is NOT migration debt — see below.

## The resolver, in decision order

`resolvePlan` is pure; everything ambient is a parameter.

1. **Instance guard** — an agent session bound to another instance is a usage
   error, before anything else can act on the wrong box.
2. **`version` / `help`** — before every launch path, so a `--help` tacked onto a
   launch command can never boot the stack (issue #18).
3. **Utility subcommands** — `issue`, `session`, `status`, `telemetry`, … Each
   returns its own variant with its argv slice.
4. **Unknown-token rejection** — an unrecognised flag or typo'd subcommand is a
   usage error, never a silent fall-through into the default mode (issue #18).
5. **`interactive-setup`** — TTY-gated, and the TTY is the ONLY gate: headless,
   systemd and piped runs must never block on a prompt. Two reasons, both real:
   `explicit` (`podium setup` / `--reconfigure`) and `first-run` (no mode yet).
6. **`client`** — nothing runs locally; point at the server.
7. **`systemd-managed` / `detached-managed`** — `config.persistence` names a
   headless-managed install, and a bare `podium` ENSURES the split is up and
   reports status. It never hosts in this PID.
8. **`in-process`** — host server and/or daemon here: the desktop sidecar, an
   explicit component subcommand (`podium server`), and the headless `podium
   setup` web-serving fallback.

## What POD-333 removed, and what replaced it

### `reconcile-pending-persistence` (deleted)

The web setup (`setup.complete` / `setup.join`) runs inside the serving process
and cannot self-daemonize — stopping the old backend would kill the request in
flight. v1 config expressed that by writing a second field, `pendingPersistence`,
meaning "chosen but not yet applied", and the launcher carried a variant to close
the gap on the next invocation (issue #20).

The split was the mistake. `persistence` is the operator's CHOICE, and it was
chosen the moment the web setup wrote it down; whether a backend is currently
running under that choice is a **run-registry** question. Two fields for one fact
forced the resolver to branch on which of them was set.

Now: the setup surfaces write `persistence` directly, and the managed plans
*ensure* rather than merely start. `detached-managed` already did
(`ensureDetachedUp`); `systemd-managed` now installs the units when
`systemctl start` finds nothing to start — the same act the deleted plan
performed, minus the config state that used to schedule it, and idempotent on a
box whose units already exist because that box takes the first branch.

### `incomplete-headless-config` (deleted)

An `interactive-setup` *reason* meaning "mode set, no `persistence`". That shape
was genuinely ambiguous: it was either the desktop sidecar (deliberately
unmanaged) or a box configured before the persistence step existed. The resolver
guessed by TTY — routed back into setup on a terminal, fell through to in-process
without one.

`configVersion` removes the ambiguity at the source. **A v2 config that names no
`persistence` is a box that is not headless-managed, full stop**, and the
migration stamps every pre-v2 file so there is no third possibility. Absence is
now an answer, so there is nothing left to guess and nothing to special-case.

Behaviour change worth stating plainly: a pre-v2 box with a mode and no
persistence, run on a TTY, used to be routed into setup and now hosts in-process
— which is what it already did on every non-TTY run. `podium setup` remains the
way to switch it to a managed split.

### `repair-config` (kept, deliberately)

The deletion audit's `cli-launch-plan-debt` item used to anchor on this variant.
It is the wrong target: `podium setup --repair` backs up a `config.json` that
will not PARSE (issue #21). Corruption is orthogonal to versioning — a truncated
file is not an old file, and a version field does not make one readable. The
item was re-anchored onto the two states above; see the reconciliation in
`docs/rearch-deletion-audit.md`.

Correspondingly, `migrateConfigFile` does **not** rewrite a corrupt file. A
corrupt file is not an old file, and rewriting it destroys whatever the operator
had.

## The config version

`CURRENT_CONFIG_VERSION = 2`, in `packages/runtime/src/config.ts`.

- **v1** — the unversioned original: no `configVersion` key.
- **v2** — `persistence` is one field, and absent means not headless-managed.

`migrateConfig` is **pure and does not write**. The loader runs in every process
— server, daemon, janitor, every CLI invocation — and a loader that wrote would
have all of them racing to save the same result on every boot. `main()` calls
`migrateConfigFile()` once, after instance selection so a named instance migrates
its own file; everyone else gets the migrated shape in memory. Re-running a step
on its own output is a no-op, which is not a nicety but the normal case.

Migrations run **before** zod validation, because zod strips unknown keys and a
step reading a field the current schema no longer declares (`pendingPersistence`
is exactly that) would find it already gone. The result is validated afterwards,
so a migration that produces a malformed config fails where a hand-edited one
does.

A config from a NEWER Podium keeps its own version rather than being stamped
backwards — downgrading the number would make the old binary re-apply migrations
the new one already has.

`describe` names **what the version means, not the edit performed**, because a
step legitimately runs on a config it does not change: a v1 desktop-sidecar
config has no `pendingPersistence` to fold, but it is still migrated — at v2 its
absent `persistence` stops being ambiguous. Phrased as the edit, the load-time
message told that box something untrue about itself.

## Test matrix

- `apps/cli/src/cli.test.ts` — the exhaustive resolver matrix, now over
  mode × persistence × TTY. The `pendingPersistence` axis is gone: the migration
  resolves it before the plan is computed.
- `packages/runtime/src/config.test.ts` — the migrations, from **historical
  shapes named by the writer that produced them** (`applySetup` on a fresh host
  box, `applyJoin` from a one-paste join code, a detached intent, a fulfilled
  persistence beside a stale intent, the desktop sidecar), plus idempotence, the
  newer-version case, the corrupt-file case, and a contiguity check on the
  migration list.
- Real-box verification (POD-333): a v1 `applySetup` config
  (`mode: all-in-one`, `publicUrl`, `updateChannel: edge`, `port: 19099`,
  `pendingPersistence: systemd`) run through the real CLI upgraded to
  `configVersion: 2` + `persistence: systemd`, preserved every unrelated key —
  including `updateChannel: edge`, the `install.sh --channel edge --join`
  regression from issue #20 — and a second run migrated nothing and printed
  nothing.
