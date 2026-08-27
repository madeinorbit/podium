# Grok acceptance drive

| Pin | Commit time | Driven |
| --- | --- | --- |
| `c26c267be1c4b2f8cc6ccc2e66ea675e84024587` | `2026-08-27 10:54:36 +0200` | Original Grok server-driver column on named instance `grok2927` |
| `961a6992480ad279776af4354fcd2935f6bed0e8` | `2026-08-27 12:32:58 +0200` | A1b and A3 fix arms after POD-2920 and POD-2940 landed |

The original runtime used code tree `7f0d53ea1ae7bf4963db31df2fa15f2669b1e2d4`, served web source `c26c267`, and bundle `bundle+CFj5AUJr`. The fix-arm runtime used code tree `34eda83b25464e236425ecb479fa4879ebed6eab`, served web source `961a699`, bundle `bundle+k9dcbf_p`, and schema `986ebf5e8e57820c`. Server/full and daemon spawn pins are captured in every reading. Each cell used a unique directory under `/tmp/pod-2927-grok/cells/` and required the product to report `grok-acp` / `server`; no generic-pty reading was accepted.

The fourteen-cell column is complete. The later A6a PASS supersedes its initial instrumentation BLOCKED row; the A3 fix PASS supersedes its parent PARTIAL row. A1b was intentionally measured only after the queue-position fix landed. Subsequent epic commit `44c73cecfeb4fd8b02803e9e740f462df5debdc4` changes only test-configuration assertions and does not stale these runtime readings.

## Results

| Cell | Verdict | Control and clauses | Reading |
| --- | --- | --- | --- |
| A1a | PASS | Product driver `grok-acp/server`; durable user turn; delivered receipt; exact reply in 2069ms | `readings/a1a.json` |
| A2a | PASS | Product driver `grok-acp/server`; working at 199ms; zero mid-turn idle/blank samples; final idle after reply | `readings/a2a.json` |
| A2b | PASS | Product driver grok-acp/server; 19/19 fresh-boot samples idle; no working/blank sample | readings/a2b.json |
| A3 `[parent]` | PARTIAL | Product driver `grok-acp/server`; in-flight control and stop passed; durable transcript interrupt marker absent; refusal path not exercised | `readings/a3.json` |
| A5 | FAIL | Product driver `grok-acp/server`; tool call present without a paired result; reload returned the same incomplete history | `readings/a5.json` |
| A6a | BLOCKED (superseded) | Product driver `grok-acp/server`; native attach emitted no bytes or frames, so echo/resize/second-viewer clauses were unmeasurable | `readings/a6a.json` |
| A6b | PASS | Product driver `grok-acp/server`; four switches preserved original PIDs, marker, 120x40 geometry, chat reply, and CLI echo | `readings/a6b.json` |
| A7a | PASS | Product driver `grok-acp/server`; daemon 1954780→1968990 with c26 pin; same conversation ID recalled pre-restart codeword | `readings/a7a.json` |
| A7b | FAIL | Product driver `grok-acp/server`; parked and recalled context, but resurrect did not restore `live` status within 60s | `readings/a7b.json` |
| A4a | BLOCKED | Product driver `grok-acp/server`; terminal attached, but permission probe produced no durable turn, so ask/card/answer clauses were unmeasurable | `readings/a4a.json` |
| A4b | BLOCKED | Product driver `grok-acp/server`; no permission turn/ask existed, so a successful first answer and typed second refusal were unmeasurable | `readings/a4b.json` |
| A6a | PASS | Authoritative delayed attach: `grok-acp/server`; echo, 3432B resize repaint, and second-viewer marker all passed | `readings/a6a-authoritative.json` |
| A1c | BLOCKED | Product driver `grok-acp/server`; live send passed, but missing stamp and zero exact child PIDs prevented a safe dead-session control | `readings/a1c.json` |
| A9 | BLOCKED | Product driver `grok-acp/server`; live reply passed, but real target PID was unstamped, so kill/15s/300s/rebound clauses were unmeasurable | `readings/a9.json` |
| A1b `[fix]` | PASS | `grok-acp/server`; queued position 1 reached caller, survived socket reload, and delivered after busy turn | `readings/a1b-fix.json` |
| A3 `[fix]` | PASS | `grok-acp/server`; working + previews control, stopped in 90ms, durable interrupt marker present | `readings/a3-fix.json` |
