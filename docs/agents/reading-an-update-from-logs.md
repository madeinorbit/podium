# Reading an update from logs alone

POD-3224. What each of the fourteen open questions is now answered by, where the
line is written, and how to follow one update end to end across the three log
sources.

Nothing about how the updater *behaves* changed, with one named exception (Q7).

---

## The forwarding decision

**Namespace floors, not a separate forwarded event channel.**

`setNamespaceFloor(pattern, level)` in `@podium/logger` declares that a namespace
is worth *at least* `level` whatever the process default is. `PODIUM_LOG_FLOOR`
adds them from the environment.

Why a floor rather than `setNamespaceLevel`: rules resolve most-specific-wins, so
`web:updates=info` would beat a global raise to `debug` and silently **cap** the
one namespace an operator raised the client to debug in order to read. Floors
fold in with `moreVerbose`, so they can only make a namespace louder.

Why not a dedicated event channel: the client's forwarding sink deliberately pins
no threshold of its own, so raising the namespace raises what is printed and what
is forwarded together — the "one knob" property the boot level already has. A
second channel would need its own batching and back-pressure, and would bypass
the console and the flight recorder.

### What these lines now put on the wire

`@podium/logger` has no redaction layer, so flooring a namespace is a decision
about content as well as volume. Three fields are worth naming:

- `web:boot` forwards `userAgent` (first 256 chars) and `referrer` — the page the
  user came from — to their own server, and `origin`/`path` with it.
- `server:updates`'s stale-asset line records the request `Referer`, which on an
  unauthenticated route is chosen by whoever made the request. It is clamped to
  256 chars and rate-limited to 30 a minute for that reason.
- `web:reload` and `web:sw` carry service-worker `scriptURL`s, which are origin
  URLs of the user's own server.

All of it goes to the user's own Podium and nowhere else — the same hop the
existing `warn`+ stream already used — but it is more than that stream carried,
and an operator sharing a client log file should know what is in it.

**Floored to `info`:** `web:updates`, `web:sw`, `web:reload`,
`web:version-guard`, `web:chunk-recovery`, `web:boot`, `daemon:update`.
The daemon's steady forwarded stream reads the same floors, so those lines leave
a machine without anybody having raised it — which is the raise nobody thinks to
make until after the update they wanted to understand.

**Noise is bounded at the call sites, not by configuration.** In a floored
namespace: `info` is a transition or an outcome and is bounded by the update
itself; anything on a timer is `debug` and reaches the flight recorder only;
anomalies are `warn`/`error`. A whole update writes a handful of forwarded
records per tab and per machine.

The three per-second things stay off the wire by construction: the 1 s
`operations.active` poll, the 60 s `registration.update()` check, and every
reload-handshake phase.

---

## Questions → lines

### Client (web tab, desktop webview, mobile-web)

| # | Question | Line | ns / level |
|---|---|---|---|
| 1 | surface, page build + bundle hash + source digest, platform, whether the SW container is reachable, controller state | `web client booted` — `surface`, `v`, `sourceDigest`, `bundle`, `userAgent`, `serviceWorker` (`available` / `no-navigator` / `unsupported` / `refused`), `controller`, `controllerScriptURL`, `origin`, `path`. `available` is not a claim that a worker exists — see the registration line below | `web:boot` info |
| 1 | registration outcome, with the error | `service worker registered` (`swUrl`, `scope`, all four slots) / `service worker registration failed` (`err`, `available`) / `service worker registration resolved without a registration` | `web:sw` info / **error** / warn |
| 1 | waiting/installing state at registration | the four `controller`/`active`/`installing`/`waiting` fields on every `web:sw` line | `web:sw` info |
| 2 | `updatefound` | `service worker updatefound` | `web:sw` info |
| 2 | `statechange` per worker, with which worker | `service worker seen` / `service worker state changed` — `slot`, `state`, `scriptURL` | `web:sw` info |
| 2 | a worker that went redundant | `service worker became redundant` | `web:sw` **warn** |
| 2 | `controllerchange` | `service worker controllerchange` | `web:sw` info |
| 2 | the library's `needRefresh` | `the library reported a new build is ready` | `web:sw` info |
| 2 | the library's `onNeedReload` | `reloading the page` — `site: workbox-controlling` | `web:reload` info |
| 2 | first install rather than an update | `service worker precached this build for offline use` | `web:sw` info |
| 3 | every handshake's trigger, phases, snapshot | `reload handshake started` + `service-worker reload handshake state` (one per phase, with the snapshot) | `web:reload` debug |
| 3 | the handshake's OUTCOME | `reload handshake finished` — `outcome: reloading`, `via`, `signal`, `trigger`, `elapsedMs`, the snapshot | `web:reload` **info, forwarded** |
| 3 | a click that did not navigate | `reload handshake finished without navigating` — `outcome: no-replacement \| failed` | `web:reload` **warn, forwarded** |
| 4 | every self-triggered navigation, with the reason | `reloading the page` — `site`, `reason`. Sites: `handshake`, `force-reload`, `app-error`, `wire-skew`, `preload-recovery`, `restart-shell`, `setup`, `boot-notice`, `workbox-controlling` | `web:reload` info |
| 4 | a navigation that was refused | `the page could not be reloaded` / `location.reload() was refused; re-assigning the current URL` | `web:reload` **error** / warn |
| 4 | what the cache reset actually evicted | `evicted the cached interface before reloading` — `unregistered`, `cachesDeleted`, `refused` | `web:reload` info |
| 5 | panel inputs when a verdict changes | `update panel inputs changed` — `needRefresh`, `skew`, `assets`, `behind`, `state`, `indicator`, `operationTargetVersion`, `operationTargetWebDigest`, `pageVersion`, `pageDigest`, `pageBundle`, `canInstallDesktop`, `canReload`, `pending` | `web:updates` info |
| 5 | which operation this page is watching | `the operation this page is watching changed` — `operationId`, `state`, `watched`, `live`, `latest` | `web:updates` info |
| 5 | collapsed / situation transitions, `hide()` | `update panel situation` (`situation`, `collapsed`, `state`, `indicator`) and `the user hid the update panel` (`state`, `acknowledging`) | `web:updates` info |
| 6 | every action pressed | `update panel action pressed` (`action`) then `update action started` (`action`, `surface`, `operationId`) | `web:updates` info |
| 6 | the mutation RESULT | `the server answered an update mutation` — `action`, `operationId`, `alreadyRunning`, `state`, `steps`; `the server answered a cancel` — `canceled`, `refused`, `step` | `web:updates` info |
| 6 | the action's outcome and error class | `update action finished` (`elapsedMs`) / `update action failed` (`code`, `detail`, `err`) / `update action lost its answer to the restart it asked for` | `web:updates` info / **warn** / info |
| 6 | a cancel the server refused | `the server refused to cancel this operation` — `refused`, `step` | `web:updates` **warn** |
| 6 | the poll's cadence and per-arm success/failure | `update poll landed` — `cadence`, and `live`/`latest`/`fleet`/`server`/`build`/`proposal` each `unread` or their value | `web:updates` **debug** |
| 6 | when the server's facts change | `the server this page reads from changed identity` — `appVersion`, `sourceDigest`, `installKind`, `servedBundle`, `servedDigest`, `targetVersion`, `pageBundle`, `pageVersion` | `web:updates` info |
| 7 | the 60 s interval and visibility checks | `periodic service-worker update check finished` / `periodic service-worker update check was rejected` — `why: interval\|visible`, `elapsedMs`, `err` | `web:sw` **debug** |

Also already present and now floored: `served web bundle has been replaced under
this page` (`web:version-guard` warn) and the chunk-recovery lines
(`web:chunk-recovery`).

**Mobile.** The `/mobile` surface is this same web bundle — `pageSurface()`
answers `mobile` and every line above applies. The Expo app has no update path
of its own, so there is nothing for it to report; its boot record stays
ring-only on purpose (a healthy-boot line from every launch of every phone buys
nothing at the moment of a crash — see `apps/mobile/src/lib/logging.ts`).

### Server (coordinator)

| # | Question | Line | ns / level |
|---|---|---|---|
| 8 | create, and the plan in full | `operation created` — `steps`, `places` per step, `awaiting` (with `!` for required and the surface), `deferred` **with each reason**, `createdBy`, `retryOf` | `server:operations` info |
| 8 | single-flight answered | `an operation of this group is already running` / `another operation took this group while the plan was being made` | `server:operations` info |
| 8 | step enter vs re-enter | `operation step entered` / `operation step re-entered` | `server:operations` info / **debug** |
| 8 | progress | `operation step progress reported` — `reported`, `progress`, `detail` | `server:operations` **debug** |
| 8 | stall | `operation step stalled; retrying once` — `breach`, `silentMs`, `elapsedMs`, `stalls` | `server:operations` **warn** |
| 8 | fail | `operation step failed` (`code`, `detail`, `because`) and `an operation step runner threw` | `server:operations` **warn** / **error** |
| 8 | waiting and expiry | `operation is waiting on a surface only somebody else can satisfy` (`blocking`, `graceMs`) / `the waiting grace ran out` (`unanswered`, `outcome`) | `server:operations` info / **warn** |
| 8 | cancel | `operation canceled` / `cancel refused` (`refused`, `step`) | `server:operations` info |
| 8 | finish, with the shape of the run | `operation finished` — `state`, `elapsedMs`, `code`, and `steps` as `id=state` per step, suffixed `xN` when it was attempted more
than once and `+Mstall` when it stalled (e.g. `machines=donex2+1stall`), plus any `awaiting`/`deferred` still standing | `server:operations` info |
| 8 | adoption on boot | `operation adopted on boot` — `was`, `wasSteps`, `now`, `nowSteps`, `resumedStalled`; and `abandoned an operation this server cannot continue` | `server:operations` info / **error** |
| 8 | the reality adoption judged against | `reconciling an adopted update against reality` — `appVersion`, `servedWebDigest`, `parentReport`, `machines`, `behind` | `server:updates` info |
| 9 | every wave tick with gate / selected / held+reasons | `update wave tick` — `gate`, `canaryHealthy`, `concurrency`, `selected`, `held` (each with its `reason`, e.g. `coordinator-last`), `considered` *(pre-existing, POD-2741)* | `server:updates` info |
| 9 | grants issued | `update grant issued` — `machineId`, `grantId`, `fromVersion`, `targetVersion`, `coordinator`, `initiator`, `eligibility`, `because` *(pre-existing, POD-3170)* | `server:updates` info |
| 9 | machine reports and verdicts | `update machine phase` — reported vs recorded state, `percent`, `detail`, `from`, `sinceGrantMs` *(pre-existing)*; `update status dropped` for a report that was refused | `server:updates` info / warn |
| 9 | the wave decision as the panel sees it | `update wave decision` *(pre-existing)* | `server:updates` info |
| 10 | the ask to the parent, and its answer | `asking the parent to swap this server onto a new bundle` → `the parent reports the bundle on disk is now the target` (`elapsedMs`) or `the parent refused or failed the swap` | `server:updates` info / **error** |
| 10 | the restart request | `the parent accepted the handover; this server is being replaced` — `expectedVersion`, `successorParentPid`. **The last line the outgoing process writes.** Also `the parent refused the handover` | `server:updates` info / **error** |
| 10 | successor boot + the parent's outcome note | the successor's `reconciling an adopted update against reality`, carrying `parentReport` | `server:updates` info |
| 11 | served identity changes | `served identity changed` (first read: `serving`) — `appVersion`, `sourceDigest`, `webBundle`, `webDigest`, `mobileWebPresent`, `mobileWebDigest`. **On change only, not per read.** | `server:updates` info |
| 11 | rebuild requests and results | `building the development web bundles`, `development web build failed`, `the website is current, but a build step failed` *(pre-existing)* | `server:updates` info / warn |
| 12 | which pages are stale, from the server's side | `a page asked for an asset this dist no longer has` — `path`, `asset`, `referer`, `dest`. Content-hashed URLs are immutable, so a 404 on one is a document running code from a replaced dist | `server:updates` info |
| 12 | the same event from the client's side | the forwarded `served web bundle has been replaced under this page` and `update panel inputs changed` with `assets: replaced` | `web:version-guard` warn / `web:updates` info |

### Daemon (each machine) — `daemon:update`, floored to `info`

| # | Question | Line | level |
|---|---|---|---|
| 13 | grant received and accepted | `update grant accepted` — `grantId`, `fromVersion`, `targetVersion`, `action`, `sinceGrantMs` | info |
| 13 | a grant that needed nothing, or was refused | `update grant needed nothing` / `update grant refused by convergence planning` (`platform`, `detail`) / `update grant refused by this machine` (`detail`) | info |
| 13 | download with progress | `update download progress` — `percent`, `receivedBytes`, `totalBytes`, `downloadMs`. **One per decile**, not per chunk | info |
| 13 | verify | `update artifact verified` — `downloadMs`, `bytes` | info |
| 13 | swap | `update bundle swapped` (`swapMs`) or, supervised, `update parent install finished` (`installMs`) | info |
| 13 | restart | `update restarting into successor` — `totalMs`. The last line this process writes about the grant | info |
| 13 | a delivery that failed | `update grant failed` — `detail`. Written locally *before* it is reported, because the coordinator is often the thing that went away | info |
| 13 | each report sent | `update status reported` — `state`, `percent`, `phaseDetail`, `detail` | **debug** |
| 13 | boot reconciliation verdict | `boot reconciled a pending update grant` — `runningVersion`, `targetVersion`, `previousVersion`, `action` (confirm/rollback/retry), `attempts`, `reported`, `detail` | info |
| 13 | connection state around the restart | `daemon link lost; backing off before reconnecting` (`retryBackoffMs`, `lastError`) and `daemon link established` (`afterBackoffMs` — absent on a first connection) | `daemon:connection` info |

### Parent supervisor — `runtime:parent`

| # | Question | Line | level |
|---|---|---|---|
| 14 | the request as it arrived | `parent received an update request` — `requestId`, `kind`, `expectedVersion`, `requestedAt`, `pinned` | info |
| 14 | already-current | `parent swap: the bundle on disk is already the target` | info |
| 14 | step 1, the schema gate | `parent swap: refused by the schema gate before any fetch` — **nothing downloaded, nothing written** | **error** |
| 14 | step 2, verified fetch | `parent swap: artifact fetched and verified` — `bytes`, `fetchMs` | info |
| 14 | steps 3–4, swap and the VERSION fence | `parent swap: complete` (`swapMs`, `totalMs`, `swapped`) or `parent swap: the installed version is not the target` (the rolling-feed fence firing) | info / **error** |
| 14 | the answer sent back | `parent completed update swap` / `parent update swap failed` *(pre-existing)* | info / **error** |
| 14 | the health gate result | `parent health gate passed` / `parent health gate timed out` / `parent health gate abandoned; shutting down` — `expectedVersion`, `phase`, `waitedMs`, and the probe that last refused it (`serverRunning`, `serverVersion`, `daemonConnected`, `versionOk`) | info / **warn** |
| 14 | rollback | `rolling back to .old bundle` (`because`) then `rolled back; the machine is on the previous bundle again` (`version`) | **warn** |
| 14 | rollback refused | `rollback unavailable` — `why`, `because` *(pre-existing)* | **error** |
| 14 | the outcome note written | `parent wrote its outcome note for the next server to read` — `outcome`, `version`, `path` | info |
| 14 | handover | `spawning successor parent`, `handover complete; old parent exiting`, `handover failed — reclaiming supervision on the previous version` *(pre-existing)* | info / **error** |

---

## Reading one update end to end

Three sources, and each one is authoritative for a different actor:

1. **`journalctl --user -u podium.service`** — the coordinator. `server:*` and
   `runtime:parent` (the parent is the same unit).
2. **`~/.podium/logs/clients/*.ndjson`** — one file per client origin
   (`desktop-<machine>`, `web`, `mobile`). Everything the browsers and webviews
   forwarded.
3. **`~/.podium/logs/fleet/<machine>.ndjson`** — one file per remote machine.
   Everything its daemon forwarded, `daemon:update` included.

A worked trace, in the order the lines land:

```
CLIENT   web client booted                          surface, v, bundle, serviceWorker, controller
CLIENT   update panel inputs changed                behind=true, assets=replaced, skew=ok
CLIENT   update panel action pressed                action=start
CLIENT   update action started                      action=start, surface=desktop-remote
SERVER   operation created                          op_… steps=prepare,machines,server,web
                                                    deferred=[laptop:offline]
CLIENT   the server answered an update mutation     operationId=op_…, alreadyRunning=false
SERVER   operation step entered                     step=prepare
SERVER   operation step entered                     step=machines
SERVER   update wave tick                           gate=…, selected=[flatblock]
                                                    held=[{ludovico, coordinator-last}]
SERVER   update grant issued                        flatblock, grantId=…
FLEET    update grant accepted                      action=swap, fromVersion=…, targetVersion=…
FLEET    update download progress                   percent=10 … 100
FLEET    update artifact verified                   bytes=…, downloadMs=…
FLEET    update bundle swapped                      swapMs=…
FLEET    update restarting into successor           totalMs=…
FLEET    daemon link lost                           (its own restart)
SERVER   update machine phase                       flatblock restarting → current
SERVER   update grant issued                        ludovico, coordinator=true
SERVER   operation step entered                     step=server
SERVER   asking the parent to swap this server …    targetVersion=…
PARENT   parent received an update request          kind=swap, requestId=…
PARENT   parent swap: beginning                     from=…, to=…
PARENT   parent swap: artifact fetched and verified bytes=…, fetchMs=…
PARENT   parent swap: complete                      swapMs=…, totalMs=…
SERVER   the parent reports the bundle on disk …    elapsedMs=…
SERVER   the parent accepted the handover …         successorParentPid=…   ← LAST LINE, old server
                        ╴╴╴ the coordinator gap ╴╴╴
                        (clients' `update poll landed` shows every arm `unread`)
PARENT   spawning successor parent
PARENT   parent health gate passed                  serverVersion=…, daemonConnected=true
SERVER   serving                                    ← FIRST LINE, new server; the served identity
SERVER   reconciling an adopted update against …    appVersion, servedWebDigest, parentReport
SERVER   operation adopted on boot                  was=running → now=…, wasSteps/nowSteps
SERVER   operation step entered                     step=web
SERVER   served identity changed                    webBundle moved
SERVER   operation finished                         state=done, elapsedMs=…
                                                    steps=prepare=done machines=donex2+1stall …
CLIENT   the server this page reads from changed …  servedBundle ≠ pageBundle
CLIENT   update panel inputs changed                assets=replaced, state=done, behind=true
CLIENT   update panel action pressed                action=reload
CLIENT   reload handshake finished                  outcome=reloading, via=handshake,
                                                    signal=controllerchange, elapsedMs=…
CLIENT   reloading the page                         site=handshake, reason=replacement-ready
CLIENT   web client booted                          the new bundle
```

### Answering the three disputes the audit could not settle

- **"Which surface was the user on?"** — the boot record's `surface`. Five of six
  operations on the reference fleet were `desktop-remote` and no log said so.
  The boot record now also carries `serviceWorker`, which is *why* there is no
  container when there is none — `no-navigator`, `unsupported` or `refused` (an
  opaque origin whose getter throws) — rather than a bare boolean.

  It is **not** true that the desktop webview has no service worker: the
  forwarded desktop logs show 24 `Script …/sw.js load failed` rejections across
  three Macs, so the API is present and the *registration* fails. On that surface
  the boot record will read `serviceWorker: available, controller: none`, and the
  new `service worker registration failed` line (`web:sw`, error, with the scope
  and the error) is what says which of the two it was. Why that script will not
  load is not answered by any log that exists today — it is now merely
  *observable*, which is the whole scope of this issue.
- **"Click Reload and nothing happens."** — exactly one forwarded
  `web:reload` record per click. `outcome: no-replacement` at `warn` is the
  reported symptom, and it names the worker slots as they stood.
- **"I pressed Update and the offer came back."** — `the server answered an
  update mutation` (with `operationId` or `alreadyRunning`), then the following
  `update poll landed` and `the operation this page is watching changed`. A start
  that never happened and a start whose operation the next poll had not folded
  yet are now different, visible sequences.

### Turning it up

Nothing above needs a raise. If you want more:

```
podium logs level debug --role web             # a client you are not sitting at
podium logs daemon-level debug --machine <id>  # a remote machine's daemon
PODIUM_LOG='server:operations=debug'           # the coordinator
PODIUM_LOG_FLOOR='some:namespace=info'         # add a floor of your own
```

A raise lifts a floored namespace too — that is the property a floor exists to
preserve. At `debug` you additionally get: every handshake phase, every poll's
per-arm result, the 60 s check's answer, every step progress report, and every
status frame a daemon sent.
