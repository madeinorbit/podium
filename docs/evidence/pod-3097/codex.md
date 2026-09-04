# A11 Codex app-server — exact-tip cell

- Issue: POD-3097, parent POD-1761
- Verdict: **FAIL** — model/effort applied and persisted, but the product's observed projection remained absent.
- Cell start/end: `2026-08-29T21:34:54.670Z` / `2026-08-29T21:37:15.690Z`
- Exact integration tip and merge base: `fbc2f18baf77d74d370c6469444b3c3d800b0a71`
- Source trees: server `a6f3ff7c486789d88bd164019a305c83b447c0db`; daemon `db91eae2e746045aae924a056c36a10d8073ef30`; web `08a39cf1ae65ee5029e70c4c1d6574164500ad12`
- Served web: source `fbc2f18`, app `dev+fbc2f18`, wire `737208997d531cc3`, bundle `bundle+s8ci-irf`
- Isolated instance: `p3097-a11`; state root `/tmp/pod-3097-a11/state`; agent home `/tmp/pod-3097-a11/agent-home`; server/hook/relay ports `20097/47097/47098`; operator port `19797` untouched.
- Harness: `codex-cli 0.150.1`; driver `codex-app-server` advertised `model` and `effort`.

## Independent positive control

At `2026-08-29T21:34:58.711Z` the product sent marker `P3097-CODEX-CONTROL-C7HWG8I`; the provider's exact reply was observed at `2026-08-29T21:35:03.579Z`. The native `turn_context` at `2026-08-29T21:35:00.924Z` recorded the pre-change provider runtime as `gpt-5.6-sol / medium`.

## Apply, projection, and persistence

The product control route acknowledged `{ok:true,effective:"next-turn"}` at `2026-08-29T21:35:34.170Z` for `gpt-5.6-luna / max`. The immediate session row projected `requestedModel=gpt-5.6-luna` and `requestedEffort=max` while retaining no `observedModel` or `observedEffort`.

The next provider turn completed at `2026-08-29T21:35:36.445Z`; its native `turn_context` at `2026-08-29T21:35:34.281Z` recorded `gpt-5.6-luna / max`. A fresh authenticated client at `2026-08-29T21:36:21.626Z` preserved the requested pair, still without the observed pair.

The isolated server and daemon restarted from `2026-08-29T21:36:21.879Z` through `2026-08-29T21:36:24.593Z`. The post-restart provider turn completed at `2026-08-29T21:36:29.311Z`; its native `turn_context` at `2026-08-29T21:36:27.354Z` again recorded `gpt-5.6-luna / max`. At `2026-08-29T21:37:14.667Z`, the product row still had the requested pair and no observed pair.

The full machine-readable reading is in `codex.json`. The defect is isolated to requested-versus-observed projection: the provider-side native record proves both settings were used before and after restart.
