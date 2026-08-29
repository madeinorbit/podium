# A11 Grok ACP — exact-tip unsupported control

- Issue: POD-3097, parent POD-1761
- Verdict: **PASS** — model/effort configuration refused with a typed, driver-specific reason and did not mutate the session.
- Cell start/end: `2026-08-29T22:01:23.406Z` / `2026-08-29T22:02:06.734Z`
- Exact integration tip and merge base: `fbc2f18baf77d74d370c6469444b3c3d800b0a71`
- Source trees: server `a6f3ff7c486789d88bd164019a305c83b447c0db`; daemon `db91eae2e746045aae924a056c36a10d8073ef30`; web `08a39cf1ae65ee5029e70c4c1d6574164500ad12`
- Served web: source `fbc2f18`, app `dev+fbc2f18`, wire `737208997d531cc3`, bundle `bundle+s8ci-irf`
- Isolated instance: `p3097-a11`; state root `/tmp/pod-3097-a11/state`; agent home `/tmp/pod-3097-a11/agent-home`; server/hook/relay ports `20097/47097/47098`; operator port `19797` untouched.
- Harness: Grok `0.2.118`; driver `grok-acp` advertised only `permissionMode`.

At `2026-08-29T22:01:27.993Z` the independent positive control sent marker `P3097-GROK-CONTROL-YZ06I84`; the real provider reply was observed at `2026-08-29T22:01:30.293Z`.

At `2026-08-29T22:02:00.880Z`, the product route refused model `grok-4.5` plus effort `high` with `{reason:"unsupported", detail:"this driver cannot change model or effort on a running session; it can change permissionMode"}`. Neither requested nor observed model/effort fields appeared immediately, after a fresh authenticated client at `2026-08-29T22:02:00.941Z`, or after the isolated server/daemon restart completed at `2026-08-29T22:02:04.937Z`.

The full machine-readable reading is in `grok.json`.
