# POD-2198 — git delivery without a pack

What the three POD-2194 findings turned out to be, and what landed for each.

## POD-2195 — the pack is planned per delivery capability

**The defect.** `needsDevelopmentBundle(target)` asked one question — *has this
target been packed?* — and the plan, the machines runner and the fleet read model
all built on that answer. A bare `dev+<sha>` identity is never packed, so all
three said "not deliverable" about a target that is, in fact, everything a
machine running from a source checkout needs: it names a repo and a sha. The
consequence, observed live on the drive: the plan was `[prepare, machines, web]`,
the only machine in the fleet advertised `update.delivery.git` alone, and it sat
at *"Waiting for the update package."* while the server built a 325 MB tarball
nothing would ever read. Spec §9.2 says the machine that owns the checkout needs
no build and no download; §9.3 says the development path is the continuous test
of the production mechanism, so it must not be the one path that needs a
compiler.

**The rule now.** The question is about the machines, not the target:

> Pack for the machines in scope that cannot take a delivery this target already
> offers. For nobody else.

Consequences, each covered by a test:

| Fleet | Plan | Why |
|---|---|---|
| every machine takes git | no pack | nobody is waiting on a tarball |
| nothing behind | no pack | a tarball is packed FOR someone |
| git machine + bundle-only machine | pack, and **both** waved | the artifact the installed one needs is a planned step of this operation, not a state of the world it must be deferred for |
| bundle-only machine, asleep | pack, machine deferred | it converges against whatever is *published* when it wakes (§3.6); a bare identity would strand it until a human ran another update |
| caps never reported | pack | see below |
| server with no publisher, git machine | wave it anyway | git delivery needs nothing this server has to build |

**The unknown-caps judgement.** `machineCanTakeDelivery` answers *yes* for a
machine that has never reported its capabilities, deliberately: refusing it would
strand it forever. The pack question is asked the other way round — *do we
positively know this machine can take what we already have?* — because the costs
are not symmetric. Skipping a needed pack buys a wave of rejections; packing for
a machine that did not need it costs a build. So an unknown machine counts as
needing one, and the two predicates differ on purpose.

**The two other sites that asked the target-only question.**

- The **machines runner** held every fleet at *"Waiting for the update package."*
  It now asks whether the machines *this step is waiting on* can take what is
  published. The wave planner does the same per-machine filtering at grant time,
  so a mixed fleet advances its git machines and picks the rest up when the
  packed descriptor arrives. The gate still closes when no awaited machine can
  take what is published — proven by its own test.
- The fleet read model's `grantable` flag zeroed `converging`/`failed` for a
  source fleet, so Settings said nothing was happening while a machine fetched.

## POD-2197 — the dirty-checkout refusal keeps its sentence

`"No update target is configured."` reached the caller while *"The source
checkout has 2 uncommitted changes and no longer matches HEAD (ee135e3). Commit
or stash them to publish dev+ee135e3."* stayed in `preparation.failureDetail`.
That exact string is the internal precondition §6.3 set out to make unreachable:
it describes the server's bookkeeping and offers no next action.

Two things can be true when a target is missing, and they are different
sentences. The publisher **refused and knows why** — its own words are the whole
answer, including what to do about it. Or **nothing has been published on this
channel**, which is an ordinary state of the world and is now said as one:
"Nothing has been published on the development channel yet."

## POD-2196 — `podium channel dev`

`dev` is a channel the rest of the product already has: the config schema accepts
it, `FleetUpdateChannel` names it, and it is the only channel a source checkout's
own target is ever published on. The CLI accepted `stable` and `edge` alone, so a
source machine sat on `stable` — where its target never applies — and the only
way to reach `dev` was `PODIUM_UPDATE_CHANNEL`. The accepted list is now one
constant, so the refusal names what it accepts, and the usage line agrees.

**Left open, deliberately:** the approval-brokered path an agent session takes
(`podium channel <x>` inside an agent session) still refuses `dev` — that target
is a wire-typed enum in `packages/protocol`, outside this issue's files and its
wire-golden corpus. Filed separately.

## How it was verified

- `apps/server/src/modules/updates/operation.test.ts` — 100 tests, all green:
  six new plan tests and two new runner tests.
- `apps/server/src/router.updates.test.ts` — 39 tests, all green: an end-to-end
  source machine granted its own commit with `requestDestBundle` never called,
  its converging count, and the two refusal sentences.
- `apps/cli/src/cli-channel.test.ts` — 5 tests, all green.
- Every new gate proven able to fire: reverting `machineNeedsPack` to always-pack
  reds two tests, reverting the runner gate to the target-only question reds
  three, and reverting `grantable` reds one.
- Scoped typecheck `@podium/server` + `@podium/cli` (11 workspace tasks,
  `--concurrency=1`): 12/12 successful.
- Shared lane A/B at the fork point `e241d5729`: the same 7 failures in the same
  6 files on both sides (issues/sessions/superagent/oracle — none of them mine),
  1949 passed on the branch against 1936 at base, the difference being the 13
  tests added here.
