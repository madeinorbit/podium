# Grok acceptance drive

| Pin | Commit time | Driven |
| --- | --- | --- |
| `c26c267be1c4b2f8cc6ccc2e66ea675e84024587` | `2026-08-27 10:54:36 +0200` | Original Grok server-driver column on named instance `grok2927` |
| `961a6992480ad279776af4354fcd2935f6bed0e8` | `2026-08-27 12:32:58 +0200` | A3 fix arm and the now-rejected first A1b fix reading |
| `5a01098aae2cea4bbc4d7a7e893c1b70a15b137a` | `2026-08-27 13:55:45 +0200` | Superseding A1b proof and fresh POD-2942 A7b fix proof |
| `a70ffc0f8a72d73d3ae10189ac7f471b622739c9` | `2026-08-27 14:24:42 +0200` | Current exact-tip A1c/A9 stamp re-drive and landed A5 fix arm |

The original runtime used code tree `7f0d53ea1ae7bf4963db31df2fa15f2669b1e2d4`, served web source `c26c267`, and bundle `bundle+CFj5AUJr`. The 961 fix-arm runtime used code tree `34eda83b25464e236425ecb479fa4879ebed6eab`, served web source `961a699`, bundle `bundle+k9dcbf_p`, and schema `986ebf5e8e57820c`. The current fix-arm runtime uses code tree `a55459ebebced6da2c55771fd358c6f68e14a0e2`, served web source `5a01098`, bundle `bundle+D0-MLqzq`, and the same schema. Server/full and daemon spawn pins are captured in every reading. Each cell used a unique directory under an issue-owned `/tmp/pod-2927-grok*` drive root and required the product to report `grok-acp` / `server`; no generic-pty reading was accepted.

The fourteen-cell column remains complete: 10 final PASS, 2 FAIL, and 2 BLOCKED after the authoritative A1c and A9 re-drives. The later A6a PASS supersedes its initial instrumentation BLOCKED row; the A3 fix PASS supersedes its parent PARTIAL row. The 961 A1b reading is rejected because it observed no durable position after reload; the 5a reading supersedes it with the same ledger message ID, body, and numeric queue position before and after re-login. The A7b fix PASS supersedes its parent FAIL after a fresh exact-5a hibernate/resurrect drive.

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
| A7b `[parent]` | FAIL | Product driver `grok-acp/server`; parked and recalled context, but resurrect did not restore `live` status within 60s | `readings/a7b.json` |
| A7b `[fix]` | PASS | `grok-acp/server`; parked in 79ms, live in 2155ms, same conversation and transcript retained, planted word recalled on a fresh turn | `readings/a7b-fix-5a.json` |
| A4a | BLOCKED | Product driver `grok-acp/server`; terminal attached, but permission probe produced no durable turn, so ask/card/answer clauses were unmeasurable | `readings/a4a.json` |
| A4b | BLOCKED | Product driver `grok-acp/server`; no permission turn/ask existed, so a successful first answer and typed second refusal were unmeasurable | `readings/a4b.json` |
| A6a | PASS | Authoritative delayed attach: `grok-acp/server`; echo, 3432B resize repaint, and second-viewer marker all passed | `readings/a6a-authoritative.json` |
| A1c `[parent]` | BLOCKED | Product driver `grok-acp/server`; live send passed, but missing stamp and zero exact child PIDs prevented a safe dead-session control | `readings/a1c.json` |
| A1c `[single supersedes parent BLOCKED]` | FAIL | Exact marker UUID+session attributed one `grok-acp/server` child; after exact PID death, send was accepted at queued position 1 but lost through 120s | `readings/a1c-superseding-a70.json` |
| A9 `[parent]` | BLOCKED | Product driver `grok-acp/server`; live reply passed, but real target PID was unstamped, so kill/15s/300s/rebound clauses were unmeasurable | `readings/a9.json` |
| A9 `[single supersedes parent BLOCKED]` | PASS | Exact UUID+session identity `2421849:17514976`; zero survivors and rebounds at 15s and 300s; infrastructure alive 2/2 | `readings/a9-superseding-a70.json` |
| A1b `[fix rejected; superseded]` | PASS (rejected) | Immediate position and eventual delivery were observed, but no durable position survived reload | `readings/a1b-fix.json` |
| A1b `[fix supersedes rejected 961 reading]` | PASS | `grok-acp/server`; the same durable ledger row remained queued at numeric position 1 across re-login, then delivered with the exact reply | `readings/grok-a1b-superseding.json` |
| A3 `[fix]` | PASS | `grok-acp/server`; working + previews control, stopped in 90ms, durable interrupt marker present | `readings/a3-fix.json` |
