# POD-2215 — installed bundle drive through pairing: evidence

The one acceptance drive POD-2157 could not reach: an INSTALLED Podium, PAIRED to a
coordinating server, taking a bundle signed by that server's key and swapping itself.

POD-2157 proved the gate this depends on — seven arms against `fetchArtifact` with real
bytes over a real socket, including a tamper whose digest was corrected so only the
signature gate could refuse it, and both arms of `verify-headless-update.sh`. None of that
is repeated here. What is new is the **pairing that supplies the pin**, joined to a real
grant, a real swap, a real restart and a real reconnect.

- **Candidate:** `b29d4f20c` (this branch, cut from integration tip `worktree-updater-spec`)
- **Date:** 2026-08-17
- **Host:** Linux x86_64, 8 cores, 23 GB memory (2–4 GB available throughout, swap full),
  12.9 GB disk free at the start

## The four claims, and the verdicts

| # | Claim | Verdict |
|---|---|---|
| 1 | The daemon pins the server's update key at pairing | **PASS**, three independent sightings |
| 2 | A bundle signed by that key is accepted, and the machine swaps itself | **PASS**, twice — once operation-driven, once reconciler-driven |
| 3 | A bundle signed by anything else is refused | **PASS**, and as an A/B rather than a bare refusal |
| 4 | The machine comes back at the target and reconnects | **PASS**, both times, ~1 s after the swap |
| — | Found: an update waits forever for a package it cannot publish | **FAIL** → `POD-2227` |
| — | Found: an adopted operation blocks every republish | **FAIL** → `POD-2228` |
| — | Found: the reachability guard only reads the name | **FAIL** → `POD-2229` |

## Safety

Nothing touched the operator's default instance, state directory or checkout.

- Disposable checkout `/home/mgw/src/other/podium-pod2215`, created with
  `git clone --local --shared`, `origin` confirmed to be `/home/mgw/src/other/podium`, so
  its `git` never reached the operator's remote.
- Disposable coordinating server: state root `/home/mgw/src/other/podium-pod2215-state`,
  ports 18941/18942/18943, its own `PODIUM_AGENT_HOME`.
- Disposable installed machine: install directory
  `/home/mgw/src/other/podium-pod2215-install`, state root `…-istate`, its own agent home,
  hook port 18952, relay port 18953.
- **The server was bound to `127.0.0.1`, then to `127.0.1.1` — loopback throughout.**
  Nothing was ever bound to this box's public interface, its Tailscale address or a docker
  bridge. See §5 for why the second address was needed and what it cost.
- `node_modules` in the disposable checkout was hardlink-copied (`cp -al`, 24 s) from the
  main checkout, whose `bun.lock` blob is identical (`b7e5677c`); the three leftover links
  for packages that no longer exist in git (`agent-bridge`, `core`, `domain`) were pruned
  so nothing could resolve into the main checkout, and resolution was then proved to land
  inside the disposable checkout. Measured cost: 116 MB.
- Everything was removed afterwards; the disk returned is recorded at the end.

## Instruments, all outside the product

No file under `apps/` or `packages/` was modified, and no file was written inside the
disposable checkout except the one commit named below — a file there would make it dirty
and trip the publisher's source-identity refusal, which is a different drill.

- **A supervisor**, because the disposable install had no systemd. A plain `while` loop
  around `$INSTALL/podium daemon …`, recording each generation. POD-2157 established why
  this is the honest stand-in: `cli-systemd.ts` gives an installed all-in-one three units
  with `Restart=always`, and the daemon's `process.exit(0)` after a swap restarts the
  **daemon unit alone**.
- **A forward commit** in the disposable checkout (`a094223`, one docs file) so the machine
  had somewhere to go. It is a real commit and the target is its real build.
- **A second Ed25519 identity**, minted for the negative arm, standing in for another
  server. Its private half never touched the product; only the signature it produced did.

Two things this drive did NOT use: no `BUN_BIN` build stub (both builds are real compiles
by the product's own publisher) and no hand-stamped `podium-build.json`.

## The choice POD-2221 forces, made deliberately

POD-2221 refuses a downgrade whose database the newer build has already migrated, so
POD-2157's move (`dev+<sha>` down to `0.1.3`) is refused by design. The brief offers three
ways out: a database-free machine, a target that declares its schema, or an upgrade.

**This drive took the upgrade, against a target that also declares its schema** —
`dev+b29d4f2` → `dev+a094223`, where `a094223` is a descendant of `b29d4f2`, and the dev
publisher declares `schema.migrations` from the target commit's own migrations tree
(`migrationsAtRevision`). The published target carried 60+ migration names. So the gate
could not have refused for any of the three reasons it knows.

**The honest limit, because it changes what this drive proves.** The machine here is a
paired worker — a bare daemon — and a bare daemon owns no `podium.db`. Confirmed on the
running instance: `…-istate/` held `discovery.db` and no `podium.db`, so
`readAppliedMigrations()` returned `undefined` and `refuseSchemaRegression` allowed the
convergence on its **first** branch (§13.3, "a daemon owns no database, so its rollback is
always safe") rather than by comparing the target's declaration against an applied set.
That is the correct branch for this topology, and it is the branch a real paired machine
takes. **The declaration-comparison branch is therefore not exercised by this drive** — it
remains covered by POD-2221's own table, not by anything measured here.

## 1. Pairing pins the server's key — PASS

The server mints one Ed25519 identity per instance (`readOrCreateUpdateSigningKey`,
`update-signing-key.json`, mode 0600) and sends the public half in the pairing reply; the
daemon writes it into its identity file (`connection-state.ts` `persistPairing` →
`savePairingToken`).

```
server   /home/mgw/src/other/podium-pod2215-state/update-signing-key.json
         publicKey  MCowBQYDK2VwAyEA5d/MZgx2Y1vfNvxQACV4GjlqU0XzYT7khXGIJnJfX2s=

daemon   /home/mgw/src/other/podium-pod2215-istate/daemon.json
         machineId     1b72bb94-a1a5-4f05-89c8-793cd46ace9d
         updatePubkey  MCowBQYDK2VwAyEA5d/MZgx2Y1vfNvxQACV4GjlqU0XzYT7khXGIJnJfX2s=
```

Byte-identical. The fleet then read the machine `online`, channel `dev`, advertising
`["update.delivery.feed", "update.delivery.bundle"]` — which is what `PODIUM_HOME` being
set buys (`deliveryCaps` gives a `source` install `git` alone).

**Three sightings, two of them on independent instances with different minted keys.** An
earlier instance of this drive (state root wiped afterwards) pinned
`MCowBQYDK2VwAyEADGiTFhXU8Ndw69am1NNqx2uc/OiT47uAbAKh9kGU1PY=` the same way. The pin is not
a one-off.

## 2 & 4. A signed bundle is accepted, swapped, restarted and reconnected — PASS

The target the coordinating server published for `dev+a094223`:

```
delivery   bundle
url        http://vmi3209757.contaboserver.net:18941/updates/dev-bundle/dev%2Ba094223?token=…
digest     sha256-MEL74hhy8x2aYOGvzmugFB/K48GFkRDh11WSLU9ouuM=
signature  1RQBjT/oTC0PrPDqx66mW7THODLoXG3uE9IH377fB6LPCX+w6Cnvb2NicDAs3gbuCh0mVZXGnwfuDR74b1nCCg==
schema     the migration list read off commit a094223 (`migrationsAtRevision`)
```

**Verified outside the product, so the accept is not the product marking its own homework.**
`sha256` of the tarball on disk equals the advertised digest, and the advertised signature
verifies as Ed25519 over those exact bytes under the server's public key (checked with
`cryptography`, not with any Podium code).

The drive, read off the supervisor log and the server:

```
23:59:57.824  updates.start  → op_6be056bf, state running
              plan: [machines]  ← one step, one place (pod2215-machine)
                                   no `prepare` (the pack was ready), no `server`, no `web`
              deferred: ludovico (offline), and the earlier machine row (offline)
23:59:58.579  daemon busy: fetch, digest, signature, extract, atomic rename
23:59:59.696  gen 1 exits rc=0    install VERSION dev+a094223
00:00:00.711  gen 2 starts        install VERSION dev+a094223
              podium daemon up → http://127.0.1.1:18941
```

**Under two seconds from grant to swapped install, one second to restart, and it reconnected.**
Afterwards the fleet read `targetVersion dev+a094223` and the machine
`version dev+a094223, state current, online true`.

**The swap moved real bytes, not a stamp.** The installed `podium-cli` after the swap hashes
`27bd3920c15014cd71428a41…`, identical to `headless/podium-cli` inside the `a094223` tarball
and to the build output `dist-bun/podium`; the binary it replaced — the one staged from the
`b29d4f2` tarball — hashes `307bfbcb5bd16a9ccb95951a…`. Different bytes, same path.

The whole thing was done twice, by two different callers: the sequence above is
**operation-driven** (`updates.start`), and §3's restored arm is **reconciler-driven** (the
machine reconnected behind and was granted unattended, `convergedBy: "reconciler"`).

## 3. A bundle signed by anything else is refused — PASS, as an A/B

A bare refusal proves little; a refusal that cannot be attributed proves less. So this arm
was built as an A/B in which **the signature file is the only thing that differs.**

A second Ed25519 key was minted (`MCowBQYDK2VwAyEA4YZlLFUOqkqlfxvm5Rr+e76W41G2vvFoQa9Hi18y9bc=`)
— never pinned by this daemon, never seen by it — and used to sign the *same* published
tarball. Its signature replaced the `.sig` sidecar, the genuine one kept aside.
`restoreDevBundle` re-derives the digest by streaming and checks the key *fingerprint* in
the metadata, but reads the signature verbatim, so the server republished the target with a
**correct digest and a foreign signature**. That construction is deliberate: the digest gate
cannot be what refuses this, exactly as in POD-2157's arm 3 — only now through the whole
joined-up path, with a real installed daemon, a real pin, a real grant and a real fetch.

The install was re-staged back to `dev+b29d4f2` from its own signed tarball, and the same
paired daemon restarted.

```
FOREIGN SIGNATURE
00:05:20.441  gen 1 starts     install VERSION dev+b29d4f2
00:05:21.490  updateGrant received (controlTypes=updateGrant:1)
              machine state    rejected
              detail           "signature verification FAILED — refusing to install.
                                The artifact was not signed by the trusted key (tampered,
                                corrupt, or wrong feed). No changes were made."
              machine version  dev+b29d4f2      ← unchanged
              install VERSION  dev+b29d4f2      ← unchanged
              no generation exit: the daemon did not restart, because nothing was written
```

The genuine signature was then restored. **Nothing else changed** — same daemon, same
identity file, same pin, same tarball bytes, same digest, same URL, same grant path:

```
GENUINE SIGNATURE
00:06:46.785  gen 1 starts     install VERSION dev+b29d4f2
00:06:47.937  updateGrant received (controlTypes=updateGrant:1)
00:06:49.037  gen 1 exits rc=0 install VERSION dev+a094223
00:06:50.047  gen 2 starts     podium daemon up → reconnected
              fleet            version dev+a094223, state current, online true,
                               convergedBy "reconciler"
```

So the refusal is attributable to the signature gate and to nothing else, **and** the accept
is not a gate that never fires. That pairing is the point of running it twice.

The refusal's other property is worth naming: *"No changes were made."* is literally true —
the refusal happens before `swapHeadlessBundle` is called, so there is no half-swapped
install to be bootable or not. That matters given `POD-2213`, where a **completed** swap is
what leaves an install unable to start.

## 5. Found: an update waits forever for a package it cannot publish — `POD-2227`

The first attempt at §2 did not run. It stopped in a way worth writing down, because
nothing in the operator's view said so.

```
23:41:31  updates.start → plan [prepare, machines, web]
23:41:52  prepare  running  "Building the update package… 15s"
23:42:04  the tarball is written and signed on disk (build-bun output)
by 23:42:17  prepare  done  "The update package is ready."   ← and it truly was
23:42 → 23:55  machines running "Waiting for the update package."
               its one place: pending, for over ten minutes, never granted
               NO deadline fired
```

The pack was on disk. `updates.fleet` reported `preparation {webReady: true, bundleReady:
true}`. And the published target carried **no headless artifact at all** — only the git
alternative, which an installed machine cannot take. The single statement of the cause was
one line in the server's own log:

```
23:42:11.418 WARN server:updates development bundle target unavailable
  diagnostic=development artifact publishing requires PODIUM_DEV_ARTIFACT_BASE_URL or
             config.publicUrl while remote managed machines are registered
```

`selectDevelopmentArtifactOrigin` refuses to fall back to the loopback origin once
`hasRemoteManagedMachines` is true — computed as *any* managed machine whose id is not the
host's, so one paired daemon is enough. **The guard is right**: a loopback URL handed to a
remote daemon would send it back to itself. The defect is that the refusal is invisible —
`bundleReady: true` reads as "ready", the step's own words are "Waiting for the update
package", and no deadline saves it, because the stall timer POD-2200 proved is keyed to a
*place's* clock and the place is never granted. Filed as `POD-2227`.

**How the drive got past it, stated plainly.** The server was given
`PODIUM_DEV_ARTIFACT_BASE_URL=http://vmi3209757.contaboserver.net:18941` — this box's own
hostname, which resolves to `127.0.1.1` — and bound to `127.0.1.1`. That is loopback: the
disposable server was never reachable from outside this host, which was the point. It works
because the guard in `resolveDevArtifactOrigin` tests the *spelling* of the hostname and
never resolves it. That is itself a gate that cannot say no to the case it exists for, so it
is filed too, as `POD-2229`, rather than left as a trick in a report.

## 6. Found: an adopted operation blocks every republish — `POD-2228`

After restarting the server with the origin configured, the same operation was still
`running` — correctly adopted across the restart, which POD-2194 and POD-2157 already prove
works. But nothing could be published to it:

```
/version               target dev+a094223, with a full bundle artifact   ← the publisher HAS it
updates.fleet          targetVersion null                                 ← the service does NOT
updates.checkNow       "Development target is not currently published by this source server."
```

and the `machines` step went on waiting for the package.

The A/B is one line long. The operation was cancelled; a single `/version` hit followed:

```
after cancel:  updates.fleet  targetVersion dev+a094223, behind 3
```

Nothing else changed between those two reads.

The mechanism, **read from the code rather than instrumented**: `UpdatesService.setTarget`
has a deliberate fast path — republishing the *same* version replaces its descriptor
immediately even mid-operation, because "a `dev+` identity gaining its packed tarball is the
SAME update acquiring the bytes it is about to deliver, and the running operation is waiting
for exactly that". Only a *different* version is queued under `exclusiveOperationActive`.
After a restart the in-memory `targets` map is empty, so that fast path cannot recognise the
operation's own target, and the descriptor is queued into `nextTargets` and never applied.
The operation carries the target in `details.target` and so knows it while the service does
not. Filed as `POD-2228`.

## Not reached, and why

- **The panel, photographed.** POD-2157 §2 already has the four panel states in the branch
  app. Reaching them here would mean building `apps/web/dist` in the disposable checkout and
  driving a browser against it; the box had 2–4 GB of memory available with swap full for
  the whole session, and the drive's own claims are all at the API and filesystem layer,
  where they are stronger. Every state above is read off the persisted operation, the fleet,
  the identity files and the install directory.
- **The schema gate's declaration-comparison branch.** See the section above: a paired
  worker machine owns no database, so the gate allows on its first branch. Exercising the
  comparison needs a machine that owns a `podium.db` — an all-in-one — which is a different
  topology from the one this issue is about, and faking one would have meant inventing state.
- **The macOS signed desktop drive.** Explicitly not this issue's: it needs production keys
  and a real Mac.

## What this cost the box

Measured with `df --output=avail -BM /`, so the numbers name what they count: free space on
`/`, at the moments given.

```
12902 MB  free, before anything was created
12140 MB  free, at the end of the drives, before teardown
12883 MB  free, after every disposable directory was removed
```

**743 MB returned by teardown**, and the box is left at ~12.9 GB free — 19 MB below where it
started, which is the earlier instances' churn in the filesystem's own bookkeeping.

- Disposable checkout (3.3 GB by `du`, of which `node_modules` is shared inodes), server
  state root, installed instance, machine state root and both agent homes: **all removed**;
  `/home/mgw/src/other/podium-pod2215*` no longer exists.
- Both build outputs went with the checkout that produced them: two real headless bundles
  (`dev+b29d4f2`, 49,728,301 bytes; `dev+a094223`, 49,719,409 bytes), their signatures and
  metadata, `dist-bun/podium`, `apps/web/dist` and `apps/mobile/dist`.
- Nothing was left running: no server, no daemon, no supervisor loop, no browser. Ports
  18941–3 and 18952–3 are clear.
- `node_modules` in this worktree is kept. It is a symlink farm hardlink-copied from a
  sibling in 0.04 s at no measurable disk cost; `du` reports 1.1 MB and removing it would
  return nothing real.
- The operator's default instance, state directory, checkout and its `dist-bun` were never
  touched, and the disposable checkout's `origin` was the local repository throughout, so no
  `git fetch` ever reached the operator's remote.

## Builds, and the lane

Two real compiles, both run by the product's own development publisher rather than by hand:
`dev+b29d4f2` at the server's boot, and `dev+a094223` as the operation's `prepare` step. The
heavy lane (`updater-heavy-lane`) was taken immediately before each and released immediately
after — `acquired` both times, never held across the session, never renewed to keep a turn.
`free -g` was checked before each. Nothing was OOM-killed.

## Issues filed, each with a `discovered-from` edge on POD-2087

- `POD-2227` — an update waits forever for a package it cannot publish: a source coordinator
  with any paired machine refuses to advertise a bundle URL without `publicUrl`, and says so
  only in its own log while the step reads "Waiting for the update package" and no deadline
  fires.
- `POD-2228` — an operation adopted across a server restart blocks every republish, so it
  waits for a package that can never be published and nothing else can publish either until
  someone cancels it by hand.
- `POD-2229` — the artifact-origin reachability guard tests the spelling of the hostname and
  never resolves it, so a name that resolves to loopback satisfies a check whose whole
  purpose is to refuse loopback.
