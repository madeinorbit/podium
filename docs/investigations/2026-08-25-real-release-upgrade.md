# Can an existing 0.1.0 install reach the new updater?

**Short answer: yes — but only if the release it is offered publishes a desktop manifest at
the identical version. Otherwise it is stranded, silently, and its Settings panel says the
channel was checked and had nothing.**

Everything below was measured against the **real published `v0.1.0` artifact** — verified
against the production release key, installed by its own `install.sh`, running under its own
systemd units. Nothing here is inferred from source alone.

## The gate row, as it now runs

```
real-release-install          PASS  published v0.1.0 verified against the PRODUCTION release key,
                                    installed through its own installer, and 0.1.0's own code
                                    wrote its era's three-unit layout
real-release-pairing-refusal  PASS  with a divergent desktop manifest the real 0.1.0 resolver
                                    refused the whole target, naming the pairing
real-release-resolve          PASS  paired manifest, offered 0.2.0 through the URL a stable
                                    install actually fetches
real-release-converged        PASS  upgraded BY ITS OWN UPDATER; three units in, one unit out,
                                    session row and database row intact
```

Units before: `podium-server.service`, `podium-daemon.service`, `podium-janitor.service`.
Units after: `podium.service`. Update operation state: `done`.

---

## 1. The trap you asked me to look for is not the one that is there

You already knew the desktop-side trap: every dev release stamps `minRequired.desktopBridge: 1`,
a shell predating the bridge reports `0`, and `release-target.ts` refuses it — a release
requiring what only it can deliver.

**The headless path does not have that trap.** `v0.1.0` never reads `minRequired` at all, and
its schema is `passthrough`, so unknown fields are ignored. Measured by driving `v0.1.0`'s own
resolver:

| Manifest pair offered to a real 0.1.0 | Result |
| --- | --- |
| real `v0.1.0` stable pair (itself) | **accept** |
| real live edge pair, `0.1.1-edge.2` on both | **accept** |
| headless `0.2.0`, desktop shell still `0.1.1-edge.2` | **refuse** |
| headless `0.2.0`, desktop shell also `0.2.0` | **accept** |
| paired `0.2.0` + `minRequired.desktopBridge: 1` | **accept** |
| paired `0.2.0` + `minRequired.desktop: 9.9.9` | **accept** |

The last two are the point: `0.1.0` resolves happily even against a `minRequired.desktop` it
could not possibly satisfy, because it never looks.

## 2. What is actually there is stricter

`v0.1.0`'s `release-target.ts` requires **exact version equality** between the two manifests
it fetches, on every channel — including a headless Linux server that will never run a
desktop app:

```js
if (desktop.version !== target.version) {
  throw new Error(`${channel} target unavailable: desktop build for ${target.version} is not published yet`)
}
```

Pointed at a feed whose manifests disagree, the real installed binary answered:

```
stable target unavailable: desktop build for 0.2.0 is not published yet
```

with no target offered. Repair `latest.json` to the matching version, force a check, and the
same install offers `0.2.0`.

### It happens by default on edge

Edge is one standing release republished in place, and `scripts/release.ts` uploads only what
it staged:

```js
execFileSync('gh', ['release', 'upload', 'edge', ...assets, '--clobber'])
```

`latest.json` is in that list **only when the file exists in the staging dir**. So an edge cut
that does not run the desktop build does not clobber `latest.json` — it leaves the previous
one in place, still naming the previous version, beside a `podium-update.json` naming the new
one. Nothing warns.

A stable cut that *does* run the desktop workflow is safe: `desktopReleaseTag()` refuses a
stable tag that does not match the desktop version. **The exposure is the headless-only cut,
on either channel.**

Filed as **POD-2789**. The fix is a release-side constraint — a publish-time guard that
refuses to cut a release old clients cannot resolve — not a test change.

---

## 3. The fixture was not a substitute, and now that is demonstrable

`legacy-migration` renders a three-unit layout from today's `cli-systemd` and watches today's
binary migrate it. Diffed against what real `0.1.0` actually wrote:

- the fixture adds `Environment=PODIUM_PORT=18787` to all three units — **`0.1.0` never wrote it**;
- the fixture omits the `--server` arguments `0.1.0` did write
  (`daemon --local --server ws://localhost:18787`, `janitor --server http://localhost:18787`).

`reconcileSupervision` renders the new parent unit with `resolvePort()`, which reads
`PODIUM_PORT` first — so against the fixture it always finds the port in the unit env, while a
real install falls through to the per-instance default.

**How much that currently costs:** for the default instance both paths land on 18787, so the
divergence is *latent*, not user-visible. It matters because the fixture silently pins a value
the real thing derives — a future change to port resolution would be exercised only on the
branch no user is on. Not a live bug; do not treat it as one.

---

## 4. What had to be deviated from, and by how much

A real published binary installs only artifacts signed by the production release key —
`v0.1.0` bakes `PODIUM_UPDATE_PUBKEY` as a module constant with no environment override. No
test has that key and none should.

The lane substitutes that **one 60-character base64 field** inside `podium-cli`, in place:

```json
{"bytes":102623360,"sizeUnchanged":true,"occurrences":1,"offset":95564050,
 "changedBytes":43,"changedInsideConstant":true}
```

43 bytes of 102,623,360 on that run. The count varies run to run — the run-local key is
generated fresh, so how many of the 60 characters happen to differ is chance — which is why
the assertion is the **bound** (`changedInsideConstant`: every differing byte falls inside the
constant) and not a magic number. Refused unless the constant appears exactly once; refused if
the replacement is a different length, which would move every offset after it. It is the same isolation the packaged-server lane performs
by patching `update-delivery.ts` and rebuilding — applied to a real artifact instead of a
rebuild — and it says nothing about migration, topology, schema or units.

---

## 5. A 0.1.0 defect found on the way

A released `0.1.0` **cannot complete a named-instance install**. It materializes its embedded
abduco into the instance state directory *before* claiming that directory, then refuses to
adopt the now non-empty root:

```
refusing to adopt non-empty state directory .../podium/probe2 for instance 'probe2';
choose an empty root or set PODIUM_ADOPT_STATE=1 for an intentional migration
```

The channel is never persisted and every later command refuses. Fixed in current code, and it
blocks the install itself, so almost certainly nobody in the field is affected. Recorded
because it is why the new lane runs the **default** instance — which is also what a real user
has.

---

## 6. How you test it by hand

```bash
PODIUM_UPDATE_E2E_ONLY=real-release PODIUM_UPDATE_E2E_HOLD=real-release \
  bash scripts/docker-update-e2e.sh
```

This leaves a real published `0.1.0` install standing, its data seeded, and the new release
already offered to it — so the next move is the same click a user would make, and **the first
hop is performed by the old updater**. The printed instructions name the UI URL, the teardown,
and how to flip the desktop manifest back to a divergent version to watch it refuse instead.

A held sandbox was verified working: the UI answers on the host with
`appVersion 0.1.0`, `updates.fleet` reports `targetVersion 0.2.0` and `behind 1`, the three
legacy units are standing, and the seeded `real_release_probe` row is present. The
host-reachability drop-in is written for the parent unit as well as the server unit it
replaces, so the UI survives the convergence — and `podium.service.d` is not a `.service`,
so the migration's own unit listing does not see it.
