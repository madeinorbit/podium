# POD-3050 — the durable tool record for a headless Claude turn

A5 driven for real on rig `p3050`, twice: once on the fix and once on a control
commit whose product tree is byte-identical to the tip this issue branched from.
Same instance, same cell, same prompt, same fixture — the commit is the only
difference.

## The two arms

| Arm | Commit | Verdict | Plane items | Joined pairs | Reload identical |
|---|---|---|---|---|---|
| control (pre-fix) | `acdc2e4cd` | **FAIL** | 2 | 0 | true |
| fix | `edc0ca822` | **PASS** | 4 | 1 | true |

The control's agent DID run the tool. Its own harness JSONL
(`~/.claude/projects/-tmp-pod-3050-probes-claude-sdk-a5-control/…jsonl`) holds
`tool_use Bash toolu_016e4XEDekkSi6zXPzVkmCpn` and the matching `tool_result`,
and the transcript kept neither. That is the defect, measured rather than
argued: the red is "the record is missing", not "no tool ran".

## What the fix arm recorded

```
TOOL CALLS        [{"id":"toolu_01DgXo5K31ivg6RB4wGnbCmE","role":"tool","ts":"2026-08-28T14:02:34.383Z","text":"","toolName":"Bash","toolInput":"cat /tmp/pod-3050/probes/claude-sdk-a5-fix/transcript-fixture.txt","toolTitle":"Read transcript fixture","toolUseId":"toolu_01DgXo5K31ivg6RB4wGnbCmE"}]
TOOL RESULTS      [{"id":"toolu_01DgXo5K31ivg6RB4wGnbCmE-result","role":"tool","ts":"2026-08-28T14:02:34.719Z","text":"","toolResult":"transcript fixture test marker P3050-A5-MARKER-MTD0TUNC","toolUseId":"toolu_01DgXo5K31ivg6RB4wGnbCmE"}]
JOINED PAIRS      1 (call-before-result=true)
RELOAD SAME       true
```

The call and its result are two items joined on the provider's own
`tool_use.id`, the call is durably ahead of its result, and a client that opens
the session on a NEW connection replays exactly the same four items.

## Pins

Both arms verified before the cell ran: server and daemon each reporting the
checked-out commit, a clean product tree, `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` on
the daemon, no `PODIUM_STATE_DIR` / `PODIUM_AGENT_HOME` / `ABDUCO_SOCKET_DIR` /
`TMUX_TMPDIR` override, and no credential file in the isolated agent home. The
live credential's mtime is `2026-08-28T06:20:34.463Z` in BOTH pins —
unchanged across the whole drive. Nothing was copied, printed, refreshed or
rotated.

| | control | fix |
|---|---|---|
| serverSha | `acdc2e4cd` | `edc0ca822` |
| daemonSha | `acdc2e4cd` | `edc0ca822` |
| TOS on daemon | True | True |
| isolated credential present | False | False |

## What this drive does NOT show, and why

`sessions.read` answered **0 items in both arms** — for the prompt and the
answer too, not only for tool items. That is a different defect and it is
carried as POD-3059: on a named instance the daemon resolves the transcript file
under `<state>/<instance>/agent-home` while the SDK child writes it under the
ambient `$HOME`, so the file-backed read finds nothing at all. It is unrelated
to tool identity, it predates this change, and this change neither causes nor
cures it.

So the cell here is scored on the surface this issue owns: the durable
transcript plane the driver publishes, which the server retains and replays.
POD-3036's A5 read only `sessions.read` and recorded BLOCKED; until POD-3059
lands, that reading cannot move whatever the driver does.

## Running it

```
bash docs/evidence/pod-3050/drive-up.sh
. docs/evidence/pod-3050/drive-env.sh && bun --conditions=@podium/source docs/evidence/pod-3050/a5.ts fix
bash docs/evidence/pod-3050/drive-down.sh
```

Instance `p3050`, ports 19966/46966/46967. The bring-up refuses a dirty product
tree and a reused state root; the cell refuses a server or daemon that is not
running the checked-out commit, and refuses outright if a credential file has
appeared in the isolated agent home.
