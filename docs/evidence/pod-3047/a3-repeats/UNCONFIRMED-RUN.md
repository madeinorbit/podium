# The A3 run that said "did not confirm" on a live, unfrozen host

Pin `77c7b1d604e96162ec6c2b024612001aeeafce69`, instance `p3047n`,
2026-08-28 16:03:02 CEST, 1-minute load 12.98. No host freeze, no provider
refusal. Console output as printed by `run-cell.sh A3 claude-sdk`:

```
claude-sdk/A3 FAIL — interrupt clauses unmet: stopped=true exactlyOneStopRecord=true
  durableAfterReload=true outcome=unconfirmed expected=confirmed truthful=false
  idleReceiptOnePerEpoch=true stopRecordUnchangedByIdlePresses=true
control=FIRED user=true; working=true; hostChildren=1; preExistingStopRecords=0
STOPPED           true in 3857ms
STOP RECORDS      live=1 persisted=1
RECORD TEXTS      [{"id":"claude-sdk-interrupt-d1587cc4-cbbb-4ca1-b562-4759bd8028ea-1",
                    "role":"system",
                    "text":"Turn interrupted by the operator; the model host did not
                            confirm the interrupt before the turn ended."}]
OUTCOME           unconfirmed (expected confirmed)
IDLE RECEIPTS     before=0 afterTwoPresses=1 onePerEpoch=true
```

Its reading file was overwritten by the next repeat before it was copied aside.
That is a rig bookkeeping loss and it is recorded as one rather than papered
over — the console text above is the whole of what survives, and it is quoted
rather than summarised.

## Why this is not a provider refusal

A refusal writes a different record entirely,
`claude-sdk-interrupt-refused-<sid>-<epoch>` reading *"Interrupt refused by the
model provider: … The turn is still running."* Zero refusal records were
present. The host was never frozen — `FROZEN HOSTS` is absent because this was
the A3 arm, not A3NEG.

## The path that produces it

`packages/agent-runtime/src/drivers/claude-sdk/runtime.ts`, in `requestInterrupt`:

```ts
ack = await active.requestInterrupt()      // interrupt-ack, or the 5s deadline
core.interruptsInFlight -= 1
if (!core.turnOpen || core.turnEpoch !== epoch) return   // <-- turn already closed
core.interruptConfirmation = ack.outcome === 'accepted' ? 'accepted' : …
```

`closeTurn` writes the record from `core.interruptConfirmation`. If the turn
closes while the ack is still in flight, that early return leaves the field
undefined and the record is worded *"did not confirm"* — **even when the
provider accepted.** The other way in is the 5s ack deadline elapsing under
contention.

## Which direction the error runs

Conservative, and that matters. The product can under-report a confirmation it
did receive; A3NEG shows it does **not** over-report one it did not — freezing
the host produces the unconfirmed wording every time. So the failure mode is a
record that claims less than the truth, never more.

Observed **once in five** live runs at this pin. That is a race seen once, not a
rate measured; the four other runs stopped in 564–688ms and all read
*confirmed*, while this one stopped in 3857ms on the busiest host of the set.
