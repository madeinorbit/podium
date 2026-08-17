# POD-2253 — the first update stranded the old app

What was wrong, what changed, what the change reaches, and what it does not.

## The failure, restated

The update rebuilt and served the new bundle correctly. The browser kept running the old one,
could not be clicked, showed the old update dialog, and could not recover on its own — an
operator had to clear the service worker by hand. Incognito worked, which puts the fault in
worker and cache state rather than in either bundle.

Three facts, all verified before this work started, explain it:

1. The worker is registered `registerType: 'prompt'`, so a new worker installs and **waits**. It
   takes over only when the running app calls `updateServiceWorker` — which is what the old
   bundle's Reload button did.
2. This epic changed `wireSchemaDigest` (7db60e5 → 96ff366), so the old bundle could not decode
   what the new server sent, and was too broken to press its own button. **The thing that must
   authorise the swap is the thing the swap breaks.**
3. `version-guard.ts` knows how to recover — it unregisters every worker and deletes every cache
   — but was bounded by a blind `MAX_RELOADS` counter of 2 in `sessionStorage`. Once that was
   spent in a tab, the guard gave up permanently.

Fact 3 is the one that made it terminal. The guard had the remedy the whole time and declined to
apply it.

## What changed

### 1. The reload budget is spent against a build, not into the air

The loop the budget exists to stop is a tab reloading over and over at a server that keeps
handing back the **same** stale build: two attempts prove the served bytes are the problem and a
third proves nothing. A build the tab has never seen is the opposite — new evidence, and an
eviction that has never been tried against it.

So the budget is now keyed to the served build (`wireVersion/wireSchemaDigest`). A different
digest earns a full budget instead of inheriting a spent one; two reloads at the *same* digest
still stop. A server that advertises no digest collapses to one stable target, so silence cannot
masquerade as perpetual change and unbind the guard entirely.

The pre-existing bare-integer counter records attempts against a build it cannot name, so it can
never match a target and reads as unspent. That is deliberate: the tabs holding one are exactly
the tabs this stranded.

### 2. Runtime wire skew re-runs the handshake, instead of only reporting

The boot check saves the tab you open *after* an update. The tab that was open *through* it is
the bad case, and all it got was a banner telling it to reload — a sentence addressed to a
surface that no longer works.

Refused frames from the transport are proof, not suspicion: this bundle could not read what this
server sent. They now re-run the version handshake, which forces the takeover when `/version`
agrees the build genuinely changed. When the digests **match**, the skew is something other than
a stale shell and nothing happens — a reload there would be a guess dressed as a remedy.
Quarantined rows alone are not enough; only whole refused frames justify taking a running tab
away from its user.

### 3. The new worker claims clients on activation

`skipWaiting` stays **false**. Activating under a running tab would purge the precache that
tab's already-loaded bundle asks lazy chunks from, and 404 the next thing the user navigates to.
That is what `registerType: 'prompt'` is for and it is still right.

`clientsClaim` is a different decision: what happens *once the swap has been authorised*. Without
it, the freshly activated worker controls nothing until the next navigation, so `controllerchange`
never fires and the panel's Reload falls through to its two-second timeout. With it the takeover
completes in one navigation.

### 4. The gate over all of this could not have said no

`test/pwa.structure.test.ts` holds the only case that pins the service-worker wiring. It has been
reading `updates-context.tsx` since POD-2190 moved the plumbing into `UpdatesEngine.tsx`, failing
on a line that is simply not there any more — so the one gate over the service worker was silent
throughout the update that stranded browsers. It reads the engine now, and additionally pins both
worker switches and the skew recovery.

## Reach — who this saves and who it does not

**It saves future updates.** Any client running a bundle that contains this change will, on the
next digest change, evict and reload itself even if its budget was spent earlier in the session,
and will do so from a running tab as well as at boot.

**It cannot rescue a client stuck right now.** A fix that ships in the new bundle runs only once
the browser is running the new bundle, and the whole failure is that it is not. This is not a
limitation to be engineered around from inside the web app; it is what "the old bundle is what
executes" means.

**Two things do reach a currently-stuck tab, and both already work:**

- **A fresh tab.** The budget lives in `sessionStorage`, which is per-tab. A new tab (or window)
  starts with an unspent budget, and the *old* bundle's guard is perfectly capable of evicting
  and reloading — that path was never broken, only exhausted. Anyone stuck today should open the
  app in a new tab before touching devtools.
- **`/version` is a network fetch.** It is on the navigation-fallback denylist and proxied to the
  backend, so it is never answered from the precache. A stuck tab's guard is therefore always
  reading the truth; it was only declining to act on it.

**A server-side lever exists but is not built here.** A same-origin response carrying
`Clear-Site-Data: "cache", "storage"` unregisters service workers and clears caches for the
origin, and `/version` is a request every stuck client makes on boot and reaches the server. That
would reach the stranded population without devtools. It is not built here for two reasons: it
lives in `apps/server`, outside this issue's ownership, and `/version` carries no client digest,
so the server cannot tell a stuck client from a healthy one and would have to nuke every client's
cache indiscriminately. As a permanent behaviour that is too blunt; as an **operator-triggered
one-shot after a known-breaking update** it is the right shape. Filed as discovered work.

## How it was verified

**Unit.** `apps/web/src/features/setup/version-guard.test.ts`, 24 cases. Nine mutations were run
to prove the new assertions can fire — budget ignoring its target, a legacy counter honoured as
spent, an absent digest producing a new target every poll, recovery firing on quarantined rows,
the legacy write format retained, recovery reloading regardless of `/version`, `clientsClaim`
dropped, `skipWaiting` turned on beside it, and the skew recovery unwired from `AppShell`. Each
produced red; each was restored to green.

**Artifact.** `bun run build` in `apps/web`, then read the generated worker. `clientsClaim()` is
called at worker top level; `self.skipWaiting()` appears **only** inside the `SKIP_WAITING`
message handler, so the worker still waits to activate. The dist currently serving main has the
message handler and no `clientsClaim()`, which is the before-picture.

**Browser.** Headless chromium via Playwright, against the real built bundle and the real
generated worker, served by a stub whose `/version` digest changes under the running tab.

| | observed |
|---|---|
| worker as built | page controlled **without a reload** |
| same worker, `clientsClaim()` removed | page **not** controlled |
| fresh budget, unreadable build AAAA | 2 guard reloads; registrations 0, caches 0 — eviction is real |
| same build AAAA, budget spent | **0 reloads** — it says no |
| **new build BBBB, budget already spent** | **2 reloads**, budget re-keyed to BBBB — this is the issue |
| served build matches the bundle | 0 reloads, budget cleared |
| pre-fix bare counter `2`, new build | 2 reloads, budget re-keyed |

The app itself errors on the stub (there is no tRPC backend behind it), which does not affect
what is under test: the guard runs in `SetupGate`, before the replica boots, and the worker is
the real build artefact.
