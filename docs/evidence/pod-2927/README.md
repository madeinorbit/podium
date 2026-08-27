# Grok acceptance drive

| Pin | Commit time | Driven |
| --- | --- | --- |
| `c26c267be1c4b2f8cc6ccc2e66ea675e84024587` | `2026-08-27 10:54:36 +0200` | Fourteen missing Grok server-driver cells on named instance `grok2927` |

Built and runtime code tree: `7f0d53ea1ae7bf4963db31df2fa15f2669b1e2d4`. Served web source: `c26c267`; server and daemon spawn pins are recorded in every reading. Each cell uses a unique directory under `/tmp/pod-2927-grok/cells/` and requires the product to report `grok-acp` / `server`.

## Results

| Cell | Verdict | Control and clauses | Reading |
| --- | --- | --- | --- |
| A1a | PASS | Product driver `grok-acp/server`; durable user turn; delivered receipt; exact reply in 2069ms | `readings/a1a.json` |
| A2a | PASS | Product driver `grok-acp/server`; working at 199ms; zero mid-turn idle/blank samples; final idle after reply | `readings/a2a.json` |
| A2b | PASS | Product driver grok-acp/server; 19/19 fresh-boot samples idle; no working/blank sample | readings/a2b.json |
| A3 | PARTIAL | Product driver `grok-acp/server`; in-flight control and stop passed; durable transcript interrupt marker absent; refusal path not exercised | `readings/a3.json` |

| A5 | FAIL | Product driver `grok-acp/server`; tool call present without a paired result; reload returned the same incomplete history | `readings/a5.json` |

| A6a | BLOCKED | Product driver `grok-acp/server`; native attach emitted no bytes or frames, so echo/resize/second-viewer clauses were unmeasurable | `readings/a6a.json` |

| A6b | PASS | Product driver `grok-acp/server`; four switches preserved original PIDs, marker, 120x40 geometry, chat reply, and CLI echo | `readings/a6b.json` |

| A7a | PASS | Product driver `grok-acp/server`; daemon 1954780→1968990 with c26 pin; same conversation ID recalled pre-restart codeword | `readings/a7a.json` |
