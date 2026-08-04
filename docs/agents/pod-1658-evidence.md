# POD-1658 — captured evidence

Recipe and rationale: [pod-1658-source-mapped-profiles.md](pod-1658-source-mapped-profiles.md).

## Setup

- Branch `issue/1658-source-maps-so-profiles-name-real-functi`, on the tip of
  `issue/279-integration` (`f1a6025e6`).
- `bun run --filter './packages/*' build && bun run --filter @podium/web build`
  → `apps/web/dist/assets/index-C4vwNIeS.js` (+ 18 `.map` files, 23 MB).
- Served by an **isolated** instance: `PODIUM_STATE_DIR=<scratch> PODIUM_PORT=18899
  bun --conditions=@podium/source scripts/server.ts`. `~/.podium` untouched, :18787
  never bound.
- Corpus: 800 issues seeded through the CLI (`PODIUM_NO_RELAY=1`) into that instance.
  No daemon, so no sessions — this is an issues-board workload, not a reproduction of
  POD-1641's session-ownership freeze.
- 60 s CDP capture at 1 ms, route walk `/issues,/specs,/usage,/workflows` with command-
  palette keystrokes between hops. 41,500 samples, 2,170 nodes.

## The build is not shipping maps

```
$ grep -c sourceMappingURL apps/web/dist/assets/index-C4vwNIeS.js
0
$ ls apps/web/dist/assets/*.map.br
ls: cannot access '...*.map.br': No such file or directory
$ ... [precompress] 24 files: 5.10 MB raw -> 1.16 MB br / 1.43 MB gzip
```

Same 24 assets POD-1655 compressed before this change; no `.map` reference comment
anywhere in the app chunks, so no client fetches one.

## Before — the same profile, no maps (`pod-1641/cdpan.mjs`)

```
profile span 60.4 s; samples 41500

--- TOP SELF TIME ---
   52.51s  86.9% (idle)
    2.73s   4.5% (program)
    0.34s   0.6% (garbage collector)
    0.20s   0.3% u      /assets/index-C4vwNIeS.js:33:139298
    0.17s   0.3% (anon) /assets/index-C4vwNIeS.js:33:10623
    0.15s   0.3% u      /assets/index-C4vwNIeS.js:33:139298
    0.15s   0.2% iD     /assets/index-C4vwNIeS.js:33:15089
    0.14s   0.2% IE     /assets/index-C4vwNIeS.js:33:9243
    0.08s   0.1% PE     /assets/index-C4vwNIeS.js:33:8700
    0.08s   0.1% Boe    /assets/index-C4vwNIeS.js:33:7551
```

`u`, `iD`, `IE`, `PE`, `Boe` — the exact failure the issue describes. Note `u` and
`d` each appearing **twice**: separate bundle nodes for one function, splitting its
time in half and pushing it down the table.

## After — same profile, same run (`pod-1658/resolve-profile.mjs`)

```
profile span 60.4s; samples 41500; idle 86.9%, program 4.5%
scripted time 5.17s — percentages below are OF THAT; maps loaded 3;
resolved 97.8% of scripted self time

--- TOP SELF TIME (source-mapped) ---
    0.357s   6.9%  project                        packages/client-core/src/replica/kernel/facade.ts:239
    0.339s   6.6%  (garbage collector)
    0.197s   3.8%  (anon)                         packages/client-core/src/replica/use-issue-views.ts:246
    0.149s   2.9%  getAudioContext                packages/client-core/src/sound/cuelume.ts:270
    0.141s   2.7%  projectionToViewInput          packages/client-core/src/replica/issue-views.ts:387
    0.123s   2.4%  keyOf                          packages/client-core/src/replica/kernel/facade.ts:266
    0.116s   2.2%  commitHookEffectListUnmount    react-dom-client.production.js:8593
    0.094s   1.8%  updateWorkInProgressHook       react-dom-client.production.js:4455
    0.085s   1.6%  updateProperties               react-dom-client.production.js:13577
    0.083s   1.6%  commitHostUpdate               react-dom-client.production.js:8725
    0.081s   1.6%  sort                           packages/client-core/src/replica/kernel/facade.ts:260
    0.078s   1.5%  buildIssueTree                 packages/client-core/src/replica/issue-views.ts:290
    0.076s   1.5%  deriveIssueViews               packages/client-core/src/replica/issue-views.ts:179
    0.076s   1.5%  projectionOnLegacySpelling     packages/client-core/src/replica/use-issue-views.ts:222
    0.063s   1.2%  areHookInputsEqual             react-dom-client.production.js:4327
    0.059s   1.1%  deriveSnapshot                 packages/client-core/src/replica/use-issue-views.ts:104
    0.058s   1.1%  recomputeIssueProjections      packages/client-core/src/engine/optimism.ts:249

--- TOP INCLUSIVE (source-mapped) ---
    2.885s  55.8%  performWorkOnRoot              react-dom-client.production.js:10681
    2.878s  55.7%  processRootScheduleInMicrotask react-dom-client.production.js:11966
    2.215s  42.8%  renderRootSync                 react-dom-client.production.js:11120
    2.032s  39.3%  beginWork                      react-dom-client.production.js:7392
    1.854s  35.8%  renderWithHooks                react-dom-client.production.js:4333
    1.346s  26.0%  updateFunctionComponent        react-dom-client.production.js:6489
    1.169s  22.6%  attemptWalk                    packages/sync/src/replica/replica.ts:847
    1.167s  22.6%  commitRegions                  packages/sync/src/replica/replica.ts:514
    1.167s  22.6%  install                        packages/sync/src/replica/replica.ts:906
```

Every top frame is a real function at a real file and line, in our own packages
(`client-core`, `sync`) and our dependencies. `recomputeIssueProjections` — the
POD-1641 family — is named again, and `project` at
`replica/kernel/facade.ts:239` is the top self-time frame with 6.9% of scripted time.

**Acceptance met**: a CPU profile of the running, *built* app whose top self-time
frames resolve to actual functions and files.

## What this evidence does not claim

- It is not a reproduction of POD-1641's multi-minute freeze. The isolated instance
  has 800 issues, no sessions, and no daemon: 5.17 s of scripted time in a 60 s
  window, 86.9% idle. The point being proved here is *name resolution*, not a
  performance finding. Pointing the same two scripts at a real instance is the
  recipe's step 2–4 and needs nothing more from this branch.
- 97.8% of scripted self time resolved; the 2.2% that did not is inline `<script>`
  in `index.html` and Playwright's own injected `evaluate`, neither of which has a
  map.
- `docs/agents/pod-1641/cdpan.mjs` is left untouched and still correct for dev-server
  profiles.
