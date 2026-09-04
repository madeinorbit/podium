# Claude quota parity evidence

## Outcome

Both production Claude paths reached the provider and were refused for the same current reason:
**monthly spend limit exhausted**. Weekly-quota exhaustion did not reproduce. Neither path exposed
a reset time, so the reset classification is `not exposed` rather than inferred.

The credential was authenticated and unexpired throughout the drive. Its live mtime remained
`2026-08-27 15:57:22 CEST`, its access expiry was `2026-08-27 23:57:22 CEST`, and the live mtime was
unchanged after teardown. The one-use copy in the named instance's product-derived account home was
deleted at teardown; no login, refresh, or rotation was performed.

## Provenance and windows

| Time (CEST) | Pin / condition | What ran |
| --- | --- | --- |
| 2026-08-27 17:32:46 | `p2987q-8271729`; unmarked derived state root | No runtime and no credential. The first setup order was refused after the path checker created runtime directories before the product claimed the instance. |
| 2026-08-27 17:34:01–17:34:03 | `p2987q-8271735`; `8144307b4f2b106127cee3c8028f6347f13a574f` | No Claude process. Source server startup refused because this worktree had no local `node_modules`; the one-use credential copy was deleted before package-link repair. |
| 2026-08-27 17:38:01–17:40:19 | `p2987q-8271743`; `8144307b4f2b106127cee3c8028f6347f13a574f`, commit time 2026-08-27 16:29:15 CEST | The complete `claude-pty` and durable-headless `claude-sdk` drives below. |

Before runtime action, the issue branch fast-forwarded from `2e7be343a` to the exact epic tip.
`HEAD`, `git merge-base HEAD 8144307b4`, and the epic tip all resolved to the full pin above.
The server (PID 2760694) and daemon (PID 2761201) each recorded that SHA in
`PODIUM_SPAWN_SHA`, ran with this worktree as cwd, and used the named instance
`p2987q-8271743`. No `HOME`, `PODIUM_STATE_DIR`, `PODIUM_AGENT_HOME`, or
`ABDUCO_SOCKET_DIR` override selected their state or account home.

## Production-path comparison

| Path | Positive control | Provider result | Persisted product state |
| --- | --- | --- | --- |
| Interactive `claude-pty` | Claude 2.1.231 PID 2762856 was a child of the instance's abduco process, with exact session/instance/SHA environment identity and cwd `/tmp/pod-2987-20260827T1743/probes/claude-pty`. The unique prompt `P2987-PTY-MTBOSTHV` persisted and the terminal produced 6,306 bytes. | Transcript and terminal both said `You've hit your monthly spend limit`; no reset was shown. | Honest provider text persisted as an assistant item. The session stayed `live` but ended `phase=errored`, `class=unknown`, `retryable=true`, with `driverId=null`. |
| Existing process-per-turn `claude-sdk` through production durable-headless/headless-driver | The durable request identity matched Podium session `59110973-580f-431e-9d64-9d84481c45a3`; the exact runner process and environment were observed. Claude emitted an init frame naming version 2.1.231, then a live `requesting` frame and a provider `rate_limit` frame for the same native session. | Provider stream reported HTTP 429 and `You've hit your monthly spend limit`; exit code 1 and the result journal were durable. No reset was shown. | The visible thread stored only `the headless harness turn failed ... harness exited 1`. The thread cleared `turnRunning`, retained its native harness-session ID, and its Podium session was `live/idle` with `driverId=null` and no error. |

At the observed `8144307b4` pin, `claude-sdk` named the existing durable-headless/process-per-turn
adapter; no persistent `packages/agent-runtime` RuntimeDriver existed at that observed pin. The
later POD-3001 adapter is outside this drive and unclaimed by this evidence.

## Classification gaps

1. The interactive path preserves the provider's exact message, but its structured session state
   reduces a known spend-limit refusal to `unknown` and marks it retryable. It also never publishes
   the expected `claude-pty` driver ID for this failed first turn.
2. Durable headless preserves the exact provider 429 in its journal, but the human-visible thread
   collapses it to `harness exited 1`; structured session status is idle with no driver ID, account,
   or error. The provider class and any reset detail therefore do not cross the product boundary.
3. Both surfaces remain structurally retryable after the limit changes: the PTY session remains
   live and the headless thread is no longer running while retaining its native session binding.
   Recovery after an actual reset was not observed and is not claimed.
   The structured-classification repair is tracked separately as POD-3007.

The machine-readable reading is
[`readings/quota-2026-08-27T15-40-19-633Z.json`](readings/quota-2026-08-27T15-40-19-633Z.json).
It includes redacted process argv, selected non-secret identity environment fields, timestamps,
terminal/transcript state, and the reduced provider event stream. No token values are present.

## Validation and teardown

This change contains only evidence and its focused runtime probe, so no code test gate applies.
The validation is the real boundary drive above. At 2026-08-27 17:41 CEST the exact server and
daemon were stopped, no process with the rig's instance identity remained, the isolated credential
copy was absent, and the live credential mtime was unchanged.
