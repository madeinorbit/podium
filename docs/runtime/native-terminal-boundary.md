# Native terminal host boundary

POD-4293 preserves A11/B12–B15/F13/F15 from the POD-4275 artifact 1 census
(pinned to 692d8c8e8f5465112dadeff50df0f0be817e9e51). This is a prerequisite
for POD-3744's programmatic PTY removal, not another shell driver.

## Ownership and admission

`SessionTerminal.handleInputBytes` admits only the current server controller and
stamps `inputOrigin: human`; payload attribution is replaced by authenticated
transport attribution. Binary and base64 daemon frames converge through
`legacy-terminal-input.dispatchInputBytes`. Human bytes enter
`native-terminal-input.dispatchNativeInputBytes`, which rejects every other
origin before I/O or activity accounting. Shell and login bridges need no runtime
handle for this path.

For a bridgeless headed client, admission additionally requires the daemon's
live `nativeClientRequests` entry and an accepting client generation in
`opencode-attach`. The runtime attach descriptor identifies a stream, not a
writer capability. The server controller is the human authority; the daemon's
`podium-native:<session>` lease holds the provider takeover surface on behalf of
that view. Those checks serve distinct purposes and neither replaces the other.

Leaving Native removes the request before async reconciliation. Client release
revokes `acceptingInput` and clears pending bytes before waiting for startup or
parking. A warm master is retained resource state, not input authority. Rejected
or stale bytes do not record input origin or heat the composer replica. TTL,
watch tracking, pending startup input bounds, generation ownership and pressure
reclaim remain in `opencode-attach`.

## Permanent host machinery

Do not delete `wireBridge`. It connects byte output to the scheduler, screen,
observers and composer. Keep binary/base64 negotiation, accepted human attribution,
the composer input tap, server shell four-second busy heuristic, pending geometry,
resize acknowledgements, screen replay/reopen and native client output scheduling.
These implement a live terminal regardless of how an agent turn was submitted.

Resize and redraw stay host/display operations in `sessionHandlers`. Redraw uses
screen policy, host replay, client repaint or bridge repaint; it must not call a
runtime send/answer/continue verb or inject a prompt submission. Shell Ctrl-L is
a repaint byte, not Enter. The real-shell integration test leaves a command on
the input line, redraws it, verifies no file was created, then sends Enter and
observes the command's file output.

The spawn predicate `hostHasNoRuntimeSession = !profile || !!msg.loginHarness`
remains authoritative for the permanent driverless population. Nullable selected
driver or absent family is not evidence for disposal. Keep host parking's explicit
shell/login protection separate from its conservative unknown-family handling.
Metadata's bound-or-selected family projection, unknown/native display, explicit
empty attachKinds rejection and title projection are separate policies/ownership.

## Migration boundary (retired by POD-4414 Phase 0)

Programmatic send, answer and continuation belong to runtime contract verbs.
The permanent native entrypoint cannot deliver them. The explicitly named
`legacy-terminal-input` adapter keeps bridge-only delivery, permanently, for
the populations that have no driver: shell/login hosts, older unbound peers,
and sessions no driver was bound for. It cannot reach any leased native
client, even if a Native request is present. Contracted sessions reject
non-human byte frames at this adapter as well.

The migration this section used to bound is done: the legacy inbox batches
(`legacyDeliveryBatches`), the headed-delivery rollout, and the
`runtimeContract` switch are all deleted — there is no agent rollout arm left
to retire and no flag-off path left to migrate. What remains above is the
permanent shape (driverless transport vs contracted delivery), not a
transition. POD-4292 owns direct-answer identity; POD-4278 owns
plain-terminal launch policy.
