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
| **interrupt** a running turn | wired | wired | wired | wired | declared capability; no conformance property found |
| **stop** a turn distinctly from interrupting | absent | absent | absent | absent | contract has `interrupt` and `stop`(session); "stop this turn, keep the session" is not modelled |
| **send-on-stop** — queue a message to fire when the turn ends | absent | absent | absent | absent | operator use today; no contract surface at all |

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
| **plan approval, elicitation, recovery** | wired | wired | wired | wired | six ask kinds exist in the protocol |

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
| **import()** an archive | absent | absent | absent | absent | throws on the daemon; blocked on POD-2415 |

## 5. Attachments

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| **staging** returns a ref matching its declaration, or a typed refusal | pinned | pinned | pinned | pinned | *staging* = putting a file somewhere the harness can read before the message references it |
| the staging declaration is **enforced when attachments reach send** | pinned | pinned | pinned | pinned | landed today; before it, deleting two guards left all 571 tests green |
| foreign ref on send is refused | pinned | pinned | pinned | pinned | a ref this driver did not mint |
| undeclared kind on send is refused | pinned | pinned | pinned | pinned | what it prevents: a text file handed to a harness as an image |

## 6. Errors and truth to humans

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| refusals are **typed**, not thrown strings | pinned | pinned | pinned | pinned | vocabulary: `unsupported`, `no_resume_ref`, `no_archive_yet`, `not_running`, `lease_held`, `needs_user`, `staging_failed`, `busy`, `timeout`, `retryable`, `approval` |
| permanent vs **not-yet** distinguished | pinned | pinned | pinned | pinned | a caller retries one and never the other |
| **provider overloaded** | absent | absent | absent | absent | no vocabulary; POD-2693 design |
| **out of quota / usage limit** | absent | wired | absent | absent | grok shows a popup (operator saw it); not in the contract |
| **API unreachable / 500** | absent | absent | absent | absent | |
| **harness not logged in** | wired | wired | wired | wired | falls back to a terminal path; the human sees a login prompt |
| **OOM / killed** | wired | wired | wired | wired | `oom`, `crashed`, `killed` exist in the vocabulary |
| a delivered message is never later shown as **failed** | absent | absent | absent | absent | known defect carried into POD-2604 |
| turn timeout reports failure, not success | pinned | — | — | — | fixed in the SDK move; other drivers unchecked |

## 7. Configuration and identity

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| **switch model** mid-session | declared | declared | declared | declared | `configure.fields` includes `model`; **no conformance property** |
| **switch effort** | declared | declared | declared | declared | same |
| **switch permission mode** | declared | declared | declared | declared | same |
| usage reported per turn | declared | declared | declared | declared | tokens, cost, context percent |
| title / accent colour | declared | declared | declared | declared | |

## 8. Harness state readout

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| working vs idle | wired | wired | wired | wired | `phase: 'working'`, `'compacting'` are the only phases in the model |
| **compacting** | wired | wired | wired | wired | |
| **has subagents running** | absent | absent | absent | absent | daemon tracks `nativeSubagentCount`; not in the driver contract |
| **waiting to be woken by a cron** | absent | absent | absent | absent | |
| **waiting on an event** (command finishing) | absent | absent | absent | absent | |
| **waiting on a subagent** | absent | absent | absent | absent | |
| **errored** as a distinct state | absent | absent | absent | absent | POD-2693's subject |
| **blocked on a human** | pinned | pinned | pinned | pinned | via interactions, not via a state |

## 9. Attachment / client terminal (the native view)

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| one control lease, unlimited spectators | pinned | pinned | pinned | pinned | |
| a human take-over lease excludes other controllers | pinned | pinned | pinned | pinned | |
| attach refuses rather than losing the session | pinned | pinned | pinned | pinned | |
| **cold start does not fake continuity** | absent | absent | absent | n/a | switching view destroys and recreates the client; the new interface paints into the old one's scrollback. POD-2761 |
| client parks and reconnects instead of cold-starting | absent | absent | absent | n/a | the warm window exists and never applies to a view switch |
| retention driven by a policy rather than a driver name | absent | absent | absent | absent | see `attachment-lifecycle.md` |

## 10. Ownership and placement

| behaviour | codex | grok-acp | opencode | terminal | notes |
|---|---|---|---|---|---|
| ships dedicated placement, or declares it does not | pinned | pinned | pinned | pinned | |
| one authority for birth, inventory and kill | absent | absent | absent | absent | spec approved (POD-2694); implementation at phase 1 |
| a stop that is verified rather than assumed | absent | absent | absent | absent | measured: four stop attempts, none held |
| units attributable to an instance | absent | absent | absent | absent | measured: 75 scopes, 69 sharing one name |

---

## What this catalogue says about the epic

**Rows that are `absent` across every driver are missing LAYERS, not missing driver
work.** Send-on-stop, rich harness state, provider error vocabulary, attachment
retention policy and process ownership are each one design away from being four
implementations away.

**`declared` is the dangerous column.** `configure` announces that a driver can
switch model, effort and permission mode, and nothing anywhere checks that the
announcement is true. That is the same shape as every defect this epic has found:
a property that holds by accident rather than by declaration.

**`wired` is the honest gap.** Interrupt is wired on all four and pinned on none.
Streaming is proven on one and wired on two.
