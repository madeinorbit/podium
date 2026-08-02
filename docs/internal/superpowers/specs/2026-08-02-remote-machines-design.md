# Making other machines usable for agent work — POD-1386

Status: design, 2026-08-02. Base `4b947e7d`.

## Why

Ludovico ran 4–6 agents at load 50–133 on 8 CPUs for a whole session. That did not
merely slow work down; it made verdicts unavailable. POD-327's 25ms latency gate
went unmeasured for fifteen hours. A second machine sat at load 0.37 on 6 idle
cores the entire time.

Capacity is only half the value. Running one suite on the second machine
immediately exposed POD-1393 — wire goldens pass 90/90 on ludovico and fail 2 of
87 on vmi from the same commit, because the corpus is generated from the agent
CLIs detected on the host. That is the third instrument this epic has caught
measuring the machine rather than the code (POD-1343, POD-1389, POD-1393). A
second machine is the only way to catch that family.

## What is actually broken

Five faults, in the order an agent hits them. Two are operational, three are code.

### 1. The second machine cannot reach the control plane (ops)

`tailscale serve status` on ludovico publishes the Podium server
(`127.0.0.1:18787`) on `https://ludovico.shetland-banjo.ts.net:55555`, marked
**tailnet only**. The port-443 Funnel proxies `127.0.0.1:62222`, a different
service. Measured from vmi: `curl https://ludovico.shetland-banjo.ts.net:55555/`
times out after 8s, and `tailscale` is not installed. vmi is a Contabo VPS with
no tailnet membership, so no path to the control plane exists.

The fix is to join vmi to the tailnet. The alternative — funnelling `:18787`
publicly — puts the control plane on the open internet and is rejected.

### 2. The second machine's daemon is pinned to a dead URL (ops)

vmi runs `podium-daemon` as a **user** unit (`systemctl --user`), active since
18 Jul. Its last journal line is `podium daemon up → wss://major-lightbox-
continuously-important.trycloudflare.com`. That ephemeral tunnel is long gone,
and `~/.podium/config.json` on vmi now carries `mode: "server"` with no
`serverUrl` at all.

Together, 1 and 2 are the whole reason vmi reads as offline (`machines.last_seen_at
= 2026-07-22T23:39:55Z`). vmi is **not retired**: it is a registered machine
(`c2ba4db0-eeb8-4768-a9be-98816c878a68`), reachable by ssh with its host key
already trusted, 6 cores, repo at `~/src/podium`, `bun` at `~/.bun/bin/bun`.

### 3. No CLI can enumerate machines (code)

`machines.list` exists as a tRPC procedure with a real authorization projection
(`router.ts:399` → `visibleMachinesFor` → `machinesForPrincipal`,
`command-ctx.ts:135-163`), and the web settings panel renders it. There is no
`podium machine` command, so an agent falls back to reading sqlite or to
`tailscale status`, which knows the network and nothing about Podium.

### 4. Machine-pinned issue start refuses on a differently-laid-out machine (code)

`issues.start` already honours a machine pin — `requireMachineForRepo`
(`workflow.ts:165`), `worktreeAdd` on that machine (`:167-172`), `spawnSession({machineId})`
(`:225`). But `requireMachineForRepo` (`machines/service.ts:405-419`) matches the
**source** repo path literally against the target's registered paths:

```ts
const hasRepo = listRepos(machineId).some((r) => repoPath === r.path || repoPath.startsWith(`${r.path}/`))
```

Ludovico's checkout is `/home/mgw/src/other/podium`; vmi's is
`/home/till/src/podium`. The pin therefore refuses with "no repo registered at
…" for every correctly-configured second machine.

Handoff does not have this bug. `SessionWorkspace.ensureTargetRepo`
(`workspace.ts:61`) keys on **`repoId`** — the stable identity POD-318 shipped —
clones to `~/podium-repos/<name>-<suffix>` when the target lacks it, and
`prepareTarget` (`workspace.ts:33-58`) translates the cwd across the two layouts.

### 5. The target has no way to obtain the base commit (code)

`worktreeAdd` passes `startPoint: row.parentBranch` (`workflow.ts:170`). Our
integration branches are local-only: `origin` is `github.com/madeinorbit/podium`
and carries no integration ref. A fresh clone on the target cannot resolve the
start point, and nothing in the start path transfers objects.

Handoff solves exactly this: `verifiedCommonBundleBases` computes what the target
provably already has, the source produces a `git bundle` of the delta, and
`transferHandoffPackage` moves it source → server → target in 8MB chunks
(`handoff-transfer.ts`), where it is fetched into the target clone
(`handoff-package.ts:560-641`).

## The worktree question, answered

> Is that a transfer, a fresh clone plus fetch, or something else?

**Clone plus fetch is not sufficient, and the reason is specific: the base is not
on any shared remote.** Both machines have the same GitHub origin, but in-flight
integration branches never go there. So the target can be brought to the right
base only by transferring the objects it is missing.

That transfer already exists and is already generic. `transferHandoffPackage` has
two callers today in two different id spaces — the handoff path passes a
`SessionId`, the workspace-fetch path passes a synthetic `ws-<uuid>` — and the
code says so in a comment with POD-1171 filed on the naming
(`handoff-transfer.ts:44-56`). A third consumer follows the grain of this code
rather than cutting across it.

So the primitive to name is not a new transfer. It is:

```
ensureWorkspaceOnMachine({ repoId, ref, targetMachineId }) -> { repoPath }
  1. ensureTargetRepo(repoId, target)      // existing: clone if absent, repoId-keyed
  2. if target cannot resolve `ref`:        // existing: revParseVerify
       bundle the delta on the source       // existing: verifiedCommonBundleBases
       transferHandoffPackage(...)          // existing: chunked pipe
       fetch the bundle on the target       // existing
```

Every step exists. The work is extraction and a second caller, not new mechanism.

### Are starting and spawning the same problem?

Same workspace mechanism, genuinely different session semantics. The difference
belongs in code, not in an assertion:

| | live conversation | worktree | correct behaviour |
|---|---|---|---|
| `issue start --machine M` | none | none yet | materialize workspace on M, `worktreeAdd`, spawn. Pure creation. |
| `agent spawn --issue X --machine M`, X homed elsewhere | none | exists, on another machine | **refuse**. A delegate on an issue is supposed to share that issue's files, and cross-machine it cannot. Point at handoff. |
| `session handoff --to M` | exists | exists, must move | same workspace primitive **plus** the session package and the binding state machine. |

The refusal in row 2 is the distinction made concrete. Silently creating a second
worktree for one issue on two machines would produce two divergent checkouts of
one branch — the failure this epic exists to stop.

`node_modules` is deliberately not part of the primitive. `worktreeAdd` does not
install dependencies locally either; agents run `bun install` in their own
worktree today. The remote case is the same case, and is documented rather than
automated.

## Deliverable

Landing order, smallest blast radius first.

1. **`podium machine list [--json]`** — a thin CLI over the existing
   `machines.list`, modelled on `quota-cli.ts`. Renders name, online, last-seen,
   the caller's `use` decision, installed and logged-in harnesses, Podium version,
   and the repos registered on each machine (joined from `repos.listDetailed`,
   rendered only for machines already inside the `visibleMachinesFor` projection,
   so no new disclosure). No new server surface and no new authorization path.
2. **`podium session handoff --to <machine>`** — a CLI over the existing
   `sessions.handoff` command. No new mechanism.
3. **`ensureWorkspaceOnMachine`** — extract the two steps above into one named
   primitive with handoff and remote-start as its callers; route `issues.start`'s
   machine pin through it instead of path equality. `requireMachineForRepo` keeps
   its remaining job: refusing an offline machine early with an actionable message.
4. **`--machine <name|id>`** on `podium issue start` and `podium issue create
   --start`; `podium agent spawn --machine` refuses cross-machine on a homed issue.
5. **`docs/agents/remote-machines.md`** — the runnable procedure and the trust
   story.

## Trust and ssh

Agent-initiated remote work does **not** go over ssh. It goes over the daemon's
authenticated WebSocket to the server, which already carries a per-machine token
(`~/.podium/daemon.json`) and is gated by the `see`/`use`/`manage` verbs on every
command. Nothing in this design mints an identity, adds an ambient principal, or
widens a capability.

ssh is an operator tool for setting a machine up, and stays that way. An agent
must not accept an unknown host key: if `ssh -o BatchMode=yes -o
StrictHostKeyChecking=yes` fails, the correct outcome is to stop and report the
fingerprint for a human to verify. This is stated in the docs deliverable so the
next agent does not have to rediscover it.

## Testing

Per `docs/agents/testing.md`, matched to risk:

- `machine-cli.ts` gets the `quota-cli.ts` treatment: a pure renderer and a
  `runMachineCli(argv, client)` core tested against a fake client, including the
  argument-error and no-relay paths.
- `ensureWorkspaceOnMachine` is tested through its ports, the way the handoff
  coordinator already is: a target that has the ref (no bundle), a target that
  does not (bundle produced and fetched), and a target whose clone is absent.
- Every instrument added must be observed **refusing** before its pass is
  trusted — a mutation that should break it, run and seen red.
- Cross-machine start is verified for real against vmi once ops step 1 lands. It
  cannot be verified before then, and no green claim will be made without it.

## Open decision

Whether item 3 lands in this issue or splits out. It is the only piece with real
blast radius: it touches the handoff choreography that POD-379's oracle pins
across two machines. Items 1, 2, 4 and 5 are independent of that call.
