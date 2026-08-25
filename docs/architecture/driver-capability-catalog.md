# Driver capability catalogue

*What a driver has to do, per harness, and where each one actually stands.*

Started 2026-08-25 for POD-1761 at the operator's request, from their list plus the
contract's own vocabulary. **This is meant to be extended.** Add a row when you find
a behaviour a driver has to get right; do not delete one because it is inconvenient.

## How to read the status column

| mark | means |
|---|---|
| **proven** | driven on a real instance, or mutation-pinned with a control that shows the delta is the change |
| **pinned** | a test fails when the behaviour is broken — verified by mutation, not by the test merely existing |
| **wired** | code exists and unit tests pass; nobody has broken it on purpose or watched it work |
| **declared** | the capability is announced in `capabilities.ts` and nothing checks the announcement is true |
| **absent** | not modelled at all |
| **n/a** | genuinely does not apply to this family |

**pinned vs proven** is the distinction this epic keeps paying for. Pinned means a
test *bites* — remove the code and something goes red. Proven means a human or a
script watched the real product do it. A suite can be fully pinned and the feature
still not work in the product: chat streaming was green for weeks while the first
turn a viewer joined never streamed at all.

---

## 1. Turn lifecycle — getting a message in and an answer out

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| send opens a turn, reports the delivery actually used | pinned | pinned | pinned | pinned | conformance: *ACCEPTED opens a turn and reports the delivery actually used* |
| **queue** when busy, with a durable position | pinned | pinned | pinned | pinned | *QUEUED carries a durable position rather than a shrug* — not a silent drop |
| **steer** — inject into a running turn | pinned | pinned | pinned | pinned | *DOES what `deliveredAs: steer` says* — the substitution nothing else catches |
| a steer **downgrade** is reported, never silent | pinned | pinned | pinned | pinned | if it could not steer it must say so |
| never reports a delivery it did not declare native | pinned | pinned | pinned | pinned | |
| `unverified` only where the family permits | pinned | pinned | pinned | pinned | terminal may; server families may not |
| **interrupt** a running turn | pinned | pinned | pinned | pinned | conformance: *REQUESTS a fence and never manufactures one*. The DRIVER half was always pinned; what was not was the wiring, and that column was right to be nervous — POD-2792 measured `sessions.interrupt` returning `{ok:true}` on the opencode and codex headless arms while the turn kept generating, because the server routed every stop down the terminal keystroke path and the daemon discarded the bytes for a session with no bridge. Wired now means wired to the button: `relay.test.ts` *the stop button on a session with no terminal [POD-2792]* pins the frame that leaves the server, and `inbox.test.ts` pins that `ok` claims the interrupt was REQUESTED and never that the turn stopped |
| **stop** a turn distinctly from interrupting | absent | absent | absent | absent | contract has `interrupt` and `stop`(session); "stop this turn, keep the session" is not modelled. The web composer's stop button already maps to `sessions.interrupt` distinct from `sessions.stop` — the UI exercises the distinction the contract lacks |
| **send-on-stop** — queue a message to fire when the turn ends | absent | absent | absent | absent | operator use today; no contract surface at all. The double-Esc recall re-populates the composer but nothing queues it |
| turn id carried, never minted — at-least-once, absent-means-absent | wired | wired | wired | wired | no driver invents a fallback id; an id-less turn is reported `unattributed`, never dropped (`turns.ts:29-68`); driver-local dedupe is POD-2497 |
| **queue abandonment** — accepted input never vanishes | pinned | pinned | pinned | pinned | POD-2297: after custody transfer a `queued` receipt is the server's last durable record; abandonment reported even for id-less turns, even across adoption and supervisor restart (codex `runtime.test.ts:827-963`, grok/opencode `queue-abandonment.test.ts`, terminal drain ports) |
| a queued turn keeps its **sender's principal** through the queue | wired | wired | wired | wired | W3 shipped the bug this prevents: a deferred turn re-authorized as a system default (`turns.ts:117-136`) |
| per-turn model/effort **override stays one turn** (vs sticky `configure`) | declared | declared | declared | declared | the failure: a "just this once" model change silently becoming permanent (`turns.ts:75`); no conformance property |
| `origin` (chat, mail, steward, auto-continue) rides onto `turn/started` | wired | wired | wired | wired | one verb, many origins — replaces `typeText`/`queueText`/`sendTextWhenReady`/`interruptText` |
| turn **verdict comes from the provider**, never inferred | pinned | — | — | — | `done \| question \| approval \| open_todos \| interrupted` (codex `map.test.ts:181,187`); other drivers unchecked |
| turn failure typed with a **disposition**; unrecognizable = retryable, never fatal | pinned | pinned | pinned | — | `rate-limit \| auth-expired \| context-overflow \| provider-error \| timeout \| interrupted` × `retryable \| needs-human \| fatal` (codex `map.test.ts:207`, grok/opencode conformance) |
| failure **detail preserved verbatim** to the human | pinned | pinned | pinned | — | codex `runtime.test.ts:247`, grok "keeps a causal 402 detail", opencode `:478` |
| graceful `stop()` drains/reports its queue; `kill()` still reports | wired | wired | wired | wired | the abandonment report is not optional on the fast path |

## 2. Streaming and observation

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| fragment stream exactly when `fine` is declared | pinned | pinned | pinned | n/a | terminal declares coarse only |
| **no** fragment while every watcher is coarse | pinned | pinned | pinned | n/a | the half that rots silently |
| fragments join their completed item | pinned | pinned | pinned | n/a | |
| stamped with the OPEN turn epoch, never a fenced one | pinned | pinned | pinned | n/a | |
| stops when the last fine watcher releases | pinned | pinned | pinned | n/a | a leaking watch looks exactly like an idle agent |
| **first turn a viewer joins streams** | **proven** | wired | wired | n/a | 119 frames vs 0 with a control (POD-2745); grok/opencode never driven — POD-2773 |
| cursors advance monotonically across a rebind | pinned | pinned | pinned | pinned | |
| event stream stays causally fenced after rebind | pinned | pinned | pinned | pinned | |
| **in-progress tool-call previews** (`partial` arm) | pinned | absent | absent | n/a | exists because codex publishes only `item/completed` — a viewer would stare at nothing during a long tool call (codex `runtime.test.ts:1030-1110`); live-only, retired by the `complete` sharing its stream identity |
| fragments are **live-only and lossy** — a bootstrap replays none | pinned | pinned | pinned | n/a | a consumer must render correctly having missed any prefix; complete items REPLACE the preview |
| one named **join key** (`streamItemIdOf`) on both sides of every fragment | pinned | pinned | pinned | n/a | never `item.id` (opencode's ids are text-derived), never the raw provider part id (`stream-identity.ts:45-62`) |
| watch level is **filtered per viewer count**, not negotiated | pinned | wired | wired | n/a | codex "counts viewers rather than tracking a level", "mutes only the fragments it never reads", "mutes the same list on a resumed connection" (`runtime.test.ts:668-708`) |
| every read **provenance-tagged**; stale `observerGeneration` rejected, never merged | pinned | pinned | pinned | pinned | generation is fenced against `binding.bindingVersion` (`events.ts:33-40`) |
| declared **cursor material** matches what the driver actually emits | declared | declared | declared | declared | `event-offset` / `ACP _meta.eventId` / `file-offset`; grok caveat: ~10 `_x.ai/*` notification families carry NO cursor and must be treated as side-channel |

## 3. Interactions — the agent asking a human

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| asked → answered, ask enumerable while open | pinned | pinned | pinned | pinned | |
| an open ask is visible in `state()`, not only on the stream | pinned | pinned | pinned | pinned | a UI that missed the event still sees it |
| answering twice is a typed error | pinned | pinned | pinned | pinned | not a double action |
| answering an unknown interaction is refused | pinned | pinned | pinned | pinned | not ignored |
| may be asked in ANY phase, including before the first turn | pinned | pinned | pinned | pinned | |
| at-least-once only where the source permits | pinned | pinned | pinned | pinned | classifier-sourced asks may repeat |
| **login** ask specifically | wired | wired | wired | wired | `openUrl` intents include `login`; no conformance property |
| **permission / approval** ask | wired | wired | wired | wired | `approval` is in the refusal vocabulary |
| **plan approval, elicitation, recovery** | wired | wired | wired | wired | six ask kinds exist in the protocol; the terminal driver's capability list omits `elicitation`, and four of six wire payloads have no producer yet |
| each ask kind carries its **typed payload**, answered out of it | pinned | pinned | pinned | wired | not just "six kinds exist" — `PermissionAsk/Answer`, `QuestionOption/Selection`, plan text, recovery choices (codex `map.test.ts:243-318`, opencode `protocol.test.ts:181-258`, grok `contract.test.ts:215,224`) |
| answers only with **decisions the ask offered** — always-allow never synthesized | pinned | wired | pinned | n/a | codex "REFUSES an always-allow the ask never offered, and leaves it open"; opencode answers a question **by label, not by index** |
| a keystroke-emulated ask it cannot answer safely **refuses and leaves the ask open** | n/a | n/a | n/a | wired | `not-yet-supported` (POD-707): the native menu's ordinals vary, so a "deny" press could approve |
| **expiry** is a third lifecycle arm; `escalateAfterMs` escalates, never auto-denies | wired | wired | wired | wired | `InteractionExpired` exists; no deadline worker exists anywhere (gap audit IS5) |
| `answeredBy` (policy / superagent / human) reported on every resolution | wired | wired | wired | wired | an answer typed into a native menu is an ACTION and the event must claim who took it |
| resume-time recovery **auto-answers to the FULL session** by default | wired | wired | wired | wired | summary-resume only when no full path exists, then recorded; background executors never stall on startup |

## 4. Lifecycle — surviving restarts, machines and time

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| **resume()** brings the CONVERSATION back, not just the ref | proven | proven | proven | proven | 8 mutation cells across 4 drivers, all red, with a control at the parent commit |
| resume refuses rather than silently starting fresh | proven | proven | proven | proven | the failure it prevents: a healthy blank session carrying the old ref |
| mints the ref its capability promises, when it promises it | pinned | pinned | pinned | pinned | codex/grok/opencode at spawn; terminal at first turn |
| **export()** produces the archive it declares | proven | proven | proven | proven | payload checked, not just metadata |
| export refuses before a resume ref exists | pinned | pinned | pinned | pinned | permanent vs not-yet distinguished |
| export → resume round trip | pinned | pinned | pinned | pinned | the half of the guarantee needing no import |
| **hibernate** refuses without a resume ref | pinned | pinned | pinned | pinned | |
| **adopt** refuses a binding whose process did not survive | pinned | pinned | pinned | pinned | adopt ≠ resume: adopt needs a live tree |
| snapshot round-trips across a supervisor restart | pinned | pinned | pinned | pinned | |
| **import()** an archive | absent | absent | absent | absent | throws on the daemon; blocked on POD-2415. The seam exists (`runtime.landArchive`, harness-mismatch guard); what is absent is daemon support |
| archive declares **byteFaithful + formatVersion**, and export matches | pinned | pinned | pinned | pinned | opencode deliberately `byteFaithful:false` (shared SQLite would over-export); backup/restore consumers must REQUIRE `byteFaithful:true` |
| archive files **relative, never escape**; binding carries no `process`/`bindingVersion` | pinned | pinned | pinned | pinned | the spread-vs-literal hazard: `Omit<>` does not stop a spread (suite `~2143-2170`) |
| **not-yet** (`no_archive_yet`) vs **never** (`unsupported`) split per host | — | pinned | — | — | grok: "says NOT YET when the harness has not written its session files" vs "says NEVER when this machine wires no reader at all" |
| **durability declared per driver** — outliving the daemon is a capability, not a rule | absent | absent | absent | absent | process-ownership decision 4: a child whose only transport is the dead daemon's pipes is not durable; plan makes codex+grok non-durable daemon children, opencode THE durable server workload; a daemon redeploy then ends in-flight codex/grok turns — a product-visible change nobody has signed off in a row until now |
| **session forking** | absent | absent | absent | absent | `codex fork` (COW), claude `--fork-session`, opencode `--fork`; grok none. No contract surface; also the guard against claude's double-attach transcript-corruption hazard |
| **checkpoint / rewind** | absent | absent | absent | absent | claude `/rewind` + file-history snapshots, grok `rewind_points.jsonl` restored on resume, opencode undo/redo; no contract surface at all |

## 5. Attachments

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| **staging** returns a ref matching its declaration, or a typed refusal | pinned | pinned | pinned | pinned | *staging* = putting a file somewhere the harness can read before the message references it |
| the staging declaration is **enforced when attachments reach send** | pinned | pinned | pinned | pinned | landed today; before it, deleting two guards left all 571 tests green |
| foreign ref on send is refused | pinned | pinned | pinned | pinned | a ref this driver did not mint |
| undeclared kind on send is refused | pinned | pinned | pinned | pinned | what it prevents: a text file handed to a harness as an image |
| **promptForm** declared — both halves or unsupported | declared | declared | declared | declared | `path-text \| local-image \| file-part`: writing bytes no prompt can consume is not support (`capabilities.ts:143-150`); terminal declines when a raw first turn cannot keep path and text atomic |
| staged bytes **contained by realpath authority check** at send | wired | wired | wired | wired | today: realpath-both-sides inside the session's staging dir, filename prefix check (`runtime/attachment-staging.ts:34-56`) |
| uploads have a **TTL, GC, and die with the session** | wired | wired | wired | wired | today: 0700/0600 dirs, 24h TTL, hourly GC, removed on exit/kill; ownership deliberately unchecked at upload (client may upload pre-spawn) |
| the client's refusal is **typed and distinguishable** from a generic failure | wired | wired | wired | wired | the composer renders "this agent cannot accept file attachments" only off `refusal.reason==='unsupported'`; re-upload required when the target machine changes |

## 6. Errors and truth to humans

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| refusals are **typed**, not thrown strings | pinned | pinned | pinned | pinned | vocabulary: `unsupported`, `no_resume_ref`, `no_archive_yet`, `not_running`, `lease_held`, `needs_user`, `staging_failed`, `busy`, `timeout`, `retryable`, `approval`, `session_ended` |
| `resume()`/`export()` reject with a **structural refusal marker**, never a bare throw | pinned | pinned | pinned | pinned | no refusal arm exists in their return types, so a bare throw is indistinguishable from a crash; `isDriverRefusal` is structural, never `instanceof` (dist/src dual-resolution) |
| permanent vs **not-yet** distinguished | pinned | pinned | pinned | pinned | a caller retries one and never the other |
| **provider overloaded / rate limit** | pinned | pinned | pinned | absent | correction: `rate-limit` and `provider-error` ARE in `TurnFailureReason` and codex/grok/opencode map them; what is absent is the product surfacing (POD-2604) and the errored *state* (POD-2693). The UI already renders `usage_limit`/`overloaded`/`billing_error` labels off `agentState.error.class` |
| **out of quota / usage limit** | absent | wired | absent | absent | grok shows a popup (operator saw it); no `TurnFailureReason` arm. Machine-scoped `runtime.quota` (`usedFraction`, `resetsAt`) exists as a type only; legacy per-harness quota fetchers (claude OAuth usage, codex rateLimits, grok billing) run outside the runtime; opencode has NO quota API at all |
| **API unreachable / 500** | n/a | n/a | n/a | n/a | design answer, not a gap: transport failure is deliberately OUTSIDE session semantics (`errors.ts:16-19`) — conflating machine-unreachable with session failure is how ghost sessions happen |
| **needs-human failure materializes as a PendingInteraction** | absent | absent | absent | absent | THE unstick invariant (gap audit IS4): `auth-expired`→`login`, `context-overflow`→`recovery`; types exist, no universal mapper — POD-2414 |
| **harness not logged in** | wired | wired | wired | wired | falls back to a terminal path; the human sees a login prompt; mid-session expiry must surface as a `login` interaction + `auth-expired` turn failure, never a special path |
| **OOM / killed** | wired | wired | wired | wired | `oom`, `crashed`, `killed` exist in the vocabulary; the sidebar renders `stopReason:'oom'` red — a driver reporting OOM as ordinary exit renders "finished" |
| `health()` reports the **cgroup's truth**, never a fabricated zero | wired | wired | wired | wired | POD-2413: `oomKills` is a cumulative counter (a session outlives a kill under `OOMPolicy=continue`), budgets carried with their ceilings, `throttleEvents` = crawling-under-MemoryHigh; baseline by cgroup creation time so adopted history is not re-announced |
| **protocol version gate refuses loudly**, majors refused, minors windowed by fixtures | pinned | pinned | pinned | n/a | machine-readable diagnostic + observed version, never a thrown string; a version range may be pinned ONLY where recorded fixtures exist behind it |
| **credential hygiene at spawn**, and the driver verifies which credential the harness chose | proven | wired | wired | wired | codex: strips 6 env keys (an inherited `OPENAI_API_KEY` outranks the ChatGPT login and bills the wrong account invisibly; `OPENAI_BASE_URL` redirects the provider), then ASKS the server which credential it chose (`live.test.ts:211`); every harness has a distinct must-strip set in the legacy manifests |
| a delivered message is never later shown as **failed** | absent | absent | absent | absent | known defect carried into POD-2604; POD-2298 is the mirror (refused receipts never correct optimistic delivered) |
| turn timeout reports failure, not success | pinned | — | — | — | fixed in the SDK move; other drivers unchecked |

## 7. Configuration and identity

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| **switch model** mid-session | declared | declared | declared | declared | `configure.fields` includes `model`; **no conformance property**; today every production driver refuses sticky configure, and the only mid-thread picker in the UI is the superagent path |
| **switch effort** | declared | declared | declared | declared | same |
| **switch permission mode** | declared | declared | declared | declared | same; grok's ACP `session/set_mode` flips it per session over the protocol — the driver controls it, not the user's config file; claude is PTY-`/model`-only |
| usage reported per turn | declared | declared | declared | declared | tokens, cost, context percent. Grok ACP carries `_meta.usage` incl. `costUsdTicks` per turn (the reference doc's "no cost" entry is wrong on this path); opencode computes+persists cost; codex exposes tokens but needs a price table; `handle.usage()` reaches **no client surface** today |
| title / accent colour | declared | declared | declared | declared | `title.source: osc \| transcript \| synthetic` is the discriminator consumers branch on; codex OSC titles are suppressed (cwd+spinner noise) and the real title comes from the rollout |
| **hidden instruction channel**, attributed, re-primed after compaction | declared | declared | declared | declared | `SessionSpec.instructions` (`--append-system-prompt`, `developer_instructions`, `--rules`, opencode config merge); the re-prime obligation has no consumer or conformance property |
| **MCP config forwarded as declared** (`path` / `inline`) | wired | declared | declared | declared | codex forwards verbatim; legacy interactive spawns forward NO MCP at all (declared gap) while headless injects per harness — the asymmetry is easy to lose |
| **subagent model override** where the harness reads one | declared | declared | declared | declared | `ModelPolicy.subagentModel`; today `CLAUDE_CODE_SUBAGENT_MODEL` env |
| spawn honours `workdir`, `env`, `initialPrompt` | wired | wired | wired | wired | initialPrompt delivered as part of spawn where the harness accepts one; argv prompts guarded by `--` so a prompt starting with `-` is not parsed as a flag |
| **model/effort observed with provenance** — requested vs seen | wired | wired | wired | wired | the UI renders dotted "requested, not yet observed" until a transcript-level model stamp appears; a driver with no stamp renders dotted forever |

## 8. Harness state readout

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| working vs idle | wired | wired | wired | wired | `phase: 'working'`, `'compacting'` are the only phases in the model. THE TERMINAL COLUMN IS DRIVEN AND STILL NOT PROVEN (POD-2801, `docs/evidence/pod-2801/`): codex, grok and opencode report `working` while producing output, and **claude does not** — 79,242 bytes across 49 of 59 one-second intervals with `phase=idle` at all 60 polls, its causal checkpoint stuck at `{transcript: 0, hook: 0}` with `lastAcceptedLiveCursor: null`. opencode read the same until POD-2801 fixed it: two readers shared one SQLite cursor, the transcript read consumed every row before the state read saw it, `onEvents` never fired, and the phase never left the boot-seeded `idle` while the agent wrote 121KB. This cell is what the `wired` column warns about — the code existed, the tests passed, and driven it did not work |
| **compacting** | wired | wired | wired | wired | |
| **has subagents running** | absent | absent | absent | absent | daemon tracks `nativeSubagentCount`; not in the driver contract |
| **waiting to be woken by a cron** | absent | absent | absent | absent | |
| **waiting on an event** (command finishing) | absent | absent | absent | absent | |
| **waiting on a subagent** | absent | absent | absent | absent | |
| **errored** as a distinct state | absent | absent | absent | absent | POD-2693's subject; `FailureDisposition:'fatal'` is the nearest typed value |
| **blocked on a human** | pinned | pinned | pinned | pinned | via interactions, not via a state |
| `lastActivityAt` is **event-time**, never observe-time | wired | wired | wired | wired | a reattach replay must not restamp recency to "now"; same discipline the legacy reducer already has |
| **observation gap declared** (`transcript_disabled`), never a silent unknown | wired | wired | wired | wired | otherwise `phase:'unknown'` renders as no badge — indistinguishable from idle |
| **open todos** as an idle verdict | wired | wired | wired | wired | `open_todos` exists in `TurnCompleted.verdict` and `IdleVerdict`; there is no todo-list surface anywhere — the only render is a badge |
| context percent where the harness reports it | wired | — | — | wired | `reportsContextPercent`-gated today; `contextUsagePercent` has zero web consumers — CLI/status only |
| boot-state **seeded when the harness fires nothing at boot** | wired | wired | wired | wired | claude fires no SessionStart at interactive boot — without seeding, the home board reads `unknown` as `working` forever |

## 9. Attachment / client terminal (the native view)

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| one control lease, unlimited spectators | pinned | pinned | pinned | pinned | |
| a human take-over lease excludes other controllers | pinned | pinned | pinned | pinned | |
| attach refuses rather than losing the session | pinned | pinned | pinned | pinned | |
| **cold start does not fake continuity** | absent | absent | absent | n/a | switching view destroys and recreates the client; the new interface paints into the old one's scrollback. POD-2761 |
| client parks and reconnects instead of cold-starting | absent | absent | absent | n/a | the warm window exists and never applies to a view switch |
| retention driven by a policy rather than a driver name | absent | absent | absent | absent | see `attachment-lifecycle.md` |
| lease **reserved before the slow client start**, rolled back on refusal | pinned | wired | pinned | n/a | closes the race where two take-overs both won (opencode `lease.test.ts:67,97`, codex reserve-then-roll-back) |
| releasing a take-over **drains what queued behind it**; a non-holder release does not | pinned | wired | pinned | n/a | codex "DELIVERS a turn parked behind a takeover the moment the lease is released" |
| a `peek` takes **nothing** — lease unchanged before and after | pinned | pinned | pinned | pinned | conformance suite |
| attach mints a **human-controller** lease, not driver-controller | pinned | pinned | pinned | pinned | mutation-proven in the corpus: flipping it leaves everything green while a steward's nudge reaches an agent with a human at the TUI |
| attach refusals drawn from the **legal subset only** | pinned | pinned | pinned | pinned | `unsupported \| not_running \| lease_held \| busy \| needs_user` — never `no_resume_ref` or `session_ended`; normalizing `busy`/`needs_user` to `unsupported` would be the costliest lie |
| per-session endpoint **refuses unauthenticated connects**; secret in env, never argv | n/a | n/a | pinned | n/a | opencode loopback TCP: driver-minted random secret, Basic auth on every request incl. health (`live-secret.test.ts`); codex needs none (0600 unix listener IS the auth boundary — posture pinned in manifest-axis); grok stdio has no addressable endpoint (its `leader.sock` is 0755, one reason leader mode was rejected) |
| `parkable` / `revokeOnRelease` **declared** rather than branched on driver name | absent | absent | absent | absent | proposed in `attachment-lifecycle.md` §3.2; today the shared layer branches on `driver === 'codex-app-server'` — this epic's most-repeated defect shape |
| **draft** read/write per declaration | wired | wired | wired | declared | server drivers own the draft as Podium state (trivially exact); terminal declares `write:false` deliberately; no conformance property; two legacy sync implementations coexist |

## 10. Ownership and placement

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| ships dedicated placement, or declares it does not | pinned | pinned | pinned | pinned | pooled, when it ever ships, visibly lacks per-session OOM/crash isolation — that cost must ride the declaration |
| one authority for birth, inventory and kill | absent | absent | absent | absent | spec approved (POD-2694); implementation at phase 1 |
| a stop that is verified rather than assumed | absent | absent | absent | absent | measured: four stop attempts, none held. Legacy already measures durable reap (`sessionKillResult{killed, reason}`) — do not lose that while building the typed version |
| **stop outcomes typed**: `verified-empty` / `job-removed` / `incomplete` | absent | absent | absent | absent | process-ownership decision 7: a platform may not claim a stronger outcome than its boundary supports |
| a kill needs **positive evidence** — an unrecognized workload is reported, never killed | absent | absent | absent | absent | decision 6; acceptance fixture: 15 synthetic orphans across 3 instances, daemon clears exactly its own 12, reports the foreign 3 |
| **labels are display; identity is exact** | absent | absent | absent | absent | decision 13: grok's unit label squashes punctuation and truncates (collision is POD-2705); labels computed-and-compared, never parsed backwards |
| units attributable to an instance | absent | absent | absent | absent | measured: 75 scopes, 69 sharing one name |
| exit is **the master's exit**, not the attach client's | wired | wired | wired | wired | legacy: `agentExit` only when the durable master is really gone — an attach-client exit must never end the session |

## 11. Runtime-level primitives — the machine, not the session

These are not per-driver rows; they are the per-machine surface (`AgentRuntime`) the
drivers plug into. Added 2026-08-25: the catalogue had zero rows for this layer, and
the gap audit says no production class implements the interface at all (LD1).

| primitive | status | notes |
|---|---|---|
| `list()` — process-table truth | declared | CORE; scope honestly declared `registered-only` today, `process-table` is the goal — "what is ACTUALLY running, not what a database thinks" |
| `inventory()` — what this machine can run, who is logged in | absent | runtime verb type-only; the legacy prober (install/version/login per harness, cached by `(machineId, homeDir)`, 60 s refresh) runs outside it |
| `capabilities(harness, driver)` | wired | must throw on an unwired driver |
| `create(spec, sessionId?)` with a host-minted id | pinned | must refuse rather than mint a different id; duplicate registration throws, never silently picks one (`runtime.test.ts:111`) |
| `quota(harness)` — machine-scoped, never per-session | absent | `QuotaSnapshot{usedFraction, resetsAt}` type-only; legacy fetchers (claude OAuth usage, codex rateLimits, grok billing) live elsewhere; opencode has no quota surface at all |
| `usage(window)` — hour×model harvest across native stores | absent | distinct from per-turn `handle.usage()`; legacy usage-scan (incl. cache-TTL splits, synthetic-sentinel exclusion, guardian rollouts) is the behaviour to absorb |
| `accounts(harness)` with `logged-in \| logged-out \| expired \| unknown` | absent | `expired` is a distinct state; multi-account per machine-per-harness |
| `login(harness, method)` as a utility session | absent | sugar over a short-lived terminal-family session running the harness's own login command, attachable, emitting `login` interactions — no parallel interactive machinery. `logout`, `exportCredential`, `seedCredential` are missing from the contract entirely |
| `import(archive)` | absent | POD-2415; `landArchive` seam exists |
| selection is a **pure, total function** of `{auth, platform, availability, preference}` | pinned | "selects an AVAILABLE driver, never a wish"; an empty availability list still answers; login gate: a logged-out harness always takes the PTY path — only it offers interactive login |
| tier boundary is enforced, with its one known hole | pinned | adding a primitive without tiering it is a compile error; BUT a verb added to `AgentSessionHandle` without a name in the union is NOT — a live gap worth closing |

## 12. What the legacy stack does that no row above covers

Behaviours in today's production path (daemon + manifests + observers) that the new
runtime must either absorb, replace deliberately, or consciously drop. Each of these
is the kind of implicit, harness-specific fact that dies silently in a rewrite.
Format: behaviour — where it lives today — where it should land.

**Spawn construction**
- Env layering `sessionEnv < harnessEnv < podiumEnv`, `PODIUM_*` relay env (session id bound via env, never spoofable argv), `PODIUM_AGENT_RELAY` withheld from shells — `control/session.ts`, `session-env.ts` → `SessionSpec.env` composition, host-owned.
- Instance HOME plus harness home selectors (`CODEX_HOME`, `GROK_HOME`); hermetic home reads as logged-out (known trap) — `session-env.ts`.
- Parent-harness control scrub (`CLAUDE_CODE_CHILD_SESSION` etc. — a daemon started inside Claude would subordinate the child) and terminal-protocol compat (`CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT` — xterm.js can't answer kitty queries; Enter/Backspace double without it) — manifests.
- Grok fresh-spawn `--session-id <uuid>` (a bare `grok` materializes no session dir until first turn — an unused session would never bind); codex `resume -C <cwd>` (dodges the recorded-cwd prompt after cross-machine handoff); codex `network_access=true` (sandbox otherwise blocks loopback and the `podium` CLI).
- Browser shims (`xdg-open`/`open`/`BROWSER` intercepts POSTing to the relay) + per-harness URL classification (claude/codex login vs link) + loopback OAuth callback proxying — `browser-open.ts` → the contract's `open-url` event arm exists (`events.ts:75`); the shim transport behind it has no runtime home yet.

**Hooks and ingest**
- Per-harness install: claude per-session settings file (15 events + `theme: auto` seed); codex GLOBAL `hooks.json`, env-gated, sha256-trusted, version-gated 0.142–0.146 with degradation diagnostics; grok GLOBAL personal hooks (14 events, `$`-token trap). All idempotent, atomic, foreign-group-preserving. `StopFailure` is the "API error skipped Stop" signal — omit it and turns hang.
- Ingest: correlation by URL path (never trusting payload), fixed instance port 45777 so baked-in settings survive daemon restart, 2 MB cap, `beforeAck` durability boundary (codex native-id receipt recorded BEFORE HTTP 200; failure → 503 so the hook does not forget the evidence).
- Spec §8 moves ingest inside the terminal driver's boundary; none of the install/refresh machinery has a contract row.

**Injection into live sessions**
- Prime injection (`SessionStart`/`UserPromptSubmit` → `additionalContext`, re-armed on `PreCompact`) and mail delivery at the blocking boundary (claude/codex block `Stop`; grok can only deny a sacrificial `PreToolUse` — POD-2026 may retire that if grok's advertised blocking stop is real), with loop guards and cooldowns — `mail-injector.ts`, `prime-injector.ts` → spec says mail collapses into `send()`; until it does, this is load-bearing.
- Submit-verification ladders, raw-first-turn, ready heuristics, echo confirmation — mostly ported into `drivers/terminal/injection.ts` as shipped constants; a THIRD un-sanitized envelope builder still lives in `packages/composer` (POD-2733).

**Observation**
- Boot-state seeding, →idle debounce (1000 ms — a false-idle beat causes premature mid-turn delivery), `sameNeed` restatement guard, working-time accumulation across rebuilds.
- Screen classifier: claude onboarding modal → synthesized interview; "Transcript saving is off" → observation gap; "Login successful" → inventory reprobe (POD-2603's subject).
- Transcript path following across cwd re-bucketing; resume binding confidence (`exact` vs `heuristic`); codex discovery floor / grok watermark (a reattached observer must not latch onto an older sibling's session).
- Git attribution (commit deltas + touched files off the hook path) and worktree-granular cwd tracking → the contract's `workspace` event arm (`CwdChanged`, `GitActivity`) is the home; the feeding machinery has no row.

**Headless / one-shot**
- Durable headless turns: per-turn state dir (sha256 key, atomic 0600 + fsync, run under abduco so a daemon restart doesn't lose the turn), single-writer dedupe by `(sessionId,turnId,requestDigest,accountId)`, request-digest verification, `HeadlessTurnError` carrying the session id of a failed post-mint turn so the thread isn't orphaned — `durable-headless.ts`, `control/headless.ts` → `procedures.oneShot` is the contract home (gap G7, type-only).
- Per-harness one-shot mapping: claude `-p` stdin (no trailing positional — variadic `--allowedTools` would swallow it), codex `exec --json`, grok resume-exec currently DISCARDING the `stopReason`/`sessionId` its own `--output-format json` returns (POD-2030 — cheap fix, no driver needed), MCP injection asymmetries (codex bearer-via-env or OAuth discovery kills the turn; malformed config throws rather than a silent tool-less run).

**Machine services**
- Login detection state machines (codex auth.json absence-grace; grok live-mutated auth.json — never cache it), login identity fingerprints, portable credential bundles, macOS keychain coordination.
- Model probing per harness; conversation discovery; host metrics; self-update/detached restart; attachment reclaim before any session is parked.

## 13. What the clients already demand

The other direction: surfaces the web/terminal clients consume that a driver must
feed, or the feature silently degrades. From the 2026-08-25 client sweep; each is a
conformance target for "capable frontend agent".

| demand | consequence when a driver doesn't provide it |
|---|---|
| `toolInputJson` on interactive + file-edit tool calls | the AskUserQuestion card, the inline edit diff and chat answering all die; the call renders as a generic folded "Ran a tool" |
| `agentState.need.ask/interview` (the pre-transcript ask) | claude writes the tool call only once it RESOLVES — without this channel a blocked session shows a bare one-liner and no card |
| `disposition` on every send (`delivered\|queued\|accepted\|held\|spawning\|dead_letter`) | every optimistic bubble sits in a 30 s grace then silently settles; queued-vs-sent is unrenderable |
| a user-turn **echo** carrying the same text or upload `toolPaths` | optimistic bubbles duplicate for 30 s; headless already can't match (server prepends context) and drops all pending on any user item |
| `driverFamily` reported (absent = assume terminal) | a server driver that stays silent gets a terminal pane whose attach is answered by nobody — `ready` never resolves; the view switcher is sticky once offered |
| `outputSeen` (durable output counter) | "attached but silent" is indistinguishable from "lost replay window" — the measured 4-minute grok self-update case |
| `stopReason` incl. `oom` distinct from `exited` | OOM renders as a green "finished" |
| transcript-level model stamp | the model readout renders dotted "requested, not yet seen" forever |
| `toolUseId` pairing, `answer:true` on the closing item, `event:'interrupt'`, `systemKind: recap/duration`, `tags` for media | each is a distinct chat-render arm; missing ones degrade to plain text rows |
| stable transcript cursor tolerant of out-of-order replay and re-emitted growing records | paging, dedupe and merge are keyed on it |
| **thinking/reasoning** | no surface exists AT ALL — no transcript role, no preview arm, no renderer; codex/claude extended thinking has nowhere to land. A decision, not an accident — but it should be a recorded one |
| **todo list state** | only signals are a Claude-only `TodoWrite` batch title and the `open_todos` badge; no list, no per-item progress |
| **plan body in the transcript** | renderable solely through the `plan-approval` payload; `ExitPlanMode` is merely kept un-folded by name |
| interaction payloads for `elicitation` (form), resume-time `recovery` | enumerable but unanswerable from every client today |
| a second streaming plane (`headlessActivity`) | superagent overlay uses an older vocabulary that does not join `streamItemIdOf` — two overlays exist for the same fact; retirement belongs to POD-2416 |

---

## What this catalogue says about the epic

**Rows that are `absent` across every driver are missing LAYERS, not missing driver
work.** Send-on-stop, rich harness state, provider error vocabulary, attachment
retention policy and process ownership are each one design away from being four
implementations away.

**CORRECTION, 2026-08-25 — I had this backwards, and it was the wrong way to be
wrong.** I wrote that `configure` announces every driver can switch model, effort
and permission mode with nothing checking the announcement. POD-2777's drive read
`capabilities.ts` instead of taking my word and found the announcement is not
there: configure is **UNSUPPORTED** for codex ("model and effort are set at thread
start and per turn"), UNSUPPORTED for opencode, UNSUPPORTED for terminal ("a TUI
takes its model at launch"), and grok declares `supported({fields:['permissionMode']})`
— explicitly **not** model or effort. No server or daemon code calls
`handle.configure()` at all, and `sessions.sendText` carries no per-turn override.
So the declaration and the behaviour AGREE, and there is no product surface to
drive on either arm. The `declared` rows below overstate what is announced; read
them against `capabilities.ts`, not against this table.

The error mattered because this document is a checklist other agents work from,
and it sent a drive after a cell that does not exist. What survives is the
narrower point: **`declared` is the column to distrust**, because a declaration is
a claim about behaviour and only a test makes it a fact. Just not this example —
here, the declaration was the honest part and my summary of it was not.

**`wired` is the honest gap.** Interrupt is wired on all four and pinned on none.
Streaming is proven on one and wired on two.

**The 2026-08-25 extension changed the shape of the gap.** Three findings from the
full-codebase sweep:

1. **The contract knows more than the catalogue did.** Queue abandonment, typed
   failure dispositions, decision-arm honesty, endpoint security, version gating,
   credential hygiene — all pinned per-driver and previously unrowed. The original
   §6 rows "provider overloaded: no vocabulary" were wrong: the vocabulary exists
   and is pinned; what is absent is the needs-human→interaction materializer
   (POD-2414) and the product surfacing (POD-2604/2693).
2. **The legacy stack knows more than the contract does.** §12 is the loss budget:
   every entry is a behaviour a rewrite drops silently because no test outside the
   legacy path pins it. The single most dangerous cluster is spawn construction —
   env hygiene, harness-specific flags, hook install — because its failure mode is
   a session that *works* and bills the wrong account, loses mail, or hangs on the
   first API error.
3. **The clients know more than both.** §13 is what "capable frontend agent"
   concretely requires; several rows (thinking, todos, plan body) are absent
   end-to-end and need a recorded decision, not a driver.
