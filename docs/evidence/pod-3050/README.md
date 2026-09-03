# POD-3050 — the durable tool record for a headless Claude turn

A5 driven for real on rig `p3050`, twice: once on the fix and once on a control
commit whose product tree is byte-identical to the coordinator root
`b5a3aa870`. Same instance, same cell, same prompt, same fixture — the commit is
the only difference.

Re-driven in full after the coordinator root advanced from `d8f0bd899` to
`b5a3aa870` (the OpenCode park-on-view-switch landing). Both arms below are on
the new root; the earlier pair on `d8f0bd899` is superseded and not kept.

## The two arms

| Arm | Commit | Verdict | Plane items | Joined pairs | Reload identical |
|---|---|---|---|---|---|
| control (root, no fix) | `e9ea0f17e` | **FAIL** | 2 | 0 | true |
| fix | `2bf997732` | **PASS** | 4 | 1 | true |

The control's agent DID run the tool. Its own harness JSONL
(`~/.claude/projects/-tmp-pod-3050-probes-claude-sdk-a5-control/d3e11124-….jsonl`)
holds `tool_use Bash toolu_017v1M2CBm49BCBusZ2NwboD` and the matching
`tool_result`, and the transcript kept neither. That is the defect, measured
rather than argued: the red is "the record is missing", not "no tool ran".

## What the fix arm recorded

```
TOOL CALLS        [{"id":"toolu_011Xg4QxzTAJoyZynU3b2LUm","role":"tool","ts":"2026-08-28T14:17:27.293Z","text":"","toolName":"Bash","toolInput":"cat /tmp/pod-3050/probes/claude-sdk-a5-fix/transcript-fixture.txt","toolTitle":"Read transcript fixture file","toolUseId":"toolu_011Xg4QxzTAJoyZynU3b2LUm"}]
TOOL RESULTS      [{"id":"toolu_011Xg4QxzTAJoyZynU3b2LUm-result","role":"tool","ts":"2026-08-28T14:17:27.616Z","text":"","toolResult":"transcript fixture test marker P3050-A5-MARKER-MTD1CX9X","toolUseId":"toolu_011Xg4QxzTAJoyZynU3b2LUm"}]
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
`TMUX_TMPDIR` override, and no credential file in the isolated agent home.

| | control | fix |
|---|---|---|
| serverSha | `e9ea0f17e` | `2bf997732` |
| daemonSha | `e9ea0f17e` | `2bf997732` |
| product tree clean | True | True |
| TOS on daemon | True | True |
| isolated credential present | False | False |

### The live credential's mtime, which moved between runs

It reads `2026-08-28T14:15:35.225Z`, size 962, where the superseded `d8f0bd899`
run recorded `06:20:34.463Z`, size 962. A moved mtime on a credential file is
exactly the thing a reader should not have to take on trust, so here is the
whole timeline rather than an assurance.

- The FIRST arm's pin was taken at **14:17:18.540Z**, and it already read
  `14:15:35.225Z`. The mtime was therefore in its final state BEFORE either
  arm's session existed — no arm can have caused it.
- Both pins read the SAME mtime and the same size, 51 seconds apart with a real
  SDK turn and a tool call in between. Neither arm moved it.
- It still reads `14:15:35.225Z`, size 962, right now, after both arms and after
  teardown. The drive left it exactly as it found it.
- No p3050 process was alive at 14:15:35Z: the previous rig was torn down at
  14:04:06Z (`drive-down.sh`) and this one started at 14:17:12Z
  (`drive-up.sh`). The change falls in a 13-minute gap with no rig at all.

What moved it is the machine's ordinary Claude login refreshing its own token in
place — the size is unchanged and only the mtime advanced. This rig never reads,
copies, prints, refreshes or rotates that file; it stats it, and the SDK reads
the account home the daemon already had. The isolated agent home is asserted
credential-FREE before every arm, and the cell refuses outright if a credential
file has appeared there.

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
