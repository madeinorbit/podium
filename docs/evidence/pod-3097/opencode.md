# A11 OpenCode server — exact-tip cell

- Issue: POD-3097, parent POD-1761
- Verdict: **FAIL** — model/effort applied and persisted, but the product's observed projection remained absent.
- Cell start/end: `2026-08-29T21:52:42.565Z` / `2026-08-29T21:55:07.997Z`
- Exact integration tip and merge base: `fbc2f18baf77d74d370c6469444b3c3d800b0a71`
- Source trees: server `a6f3ff7c486789d88bd164019a305c83b447c0db`; daemon `db91eae2e746045aae924a056c36a10d8073ef30`; web `08a39cf1ae65ee5029e70c4c1d6574164500ad12`
- Served web: source `fbc2f18`, app `dev+fbc2f18`, wire `737208997d531cc3`, bundle `bundle+s8ci-irf`
- Isolated instance: `p3097-a11`; state root `/tmp/pod-3097-a11/state`; agent home `/tmp/pod-3097-a11/agent-home`; server/hook/relay ports `20097/47097/47098`; operator port `19797` untouched.
- Harness: OpenCode `1.18.25`; driver `opencode-server` advertised `model` and `effort`.

## Independent positive control

At `2026-08-29T21:52:50.168Z` the product sent marker `P3097-OPENCODE-CONTROL-872YRK7`; the provider's exact reply was observed at `2026-08-29T21:52:53.948Z`. The isolated native OpenCode database records its assistant message at `2026-08-29 21:52:50 UTC` with provider/model `opencode-go/gpt-5.6-luna` and no effort variant.

## Apply, projection, and persistence

The product control route acknowledged `{ok:true,effective:"next-turn"}` at `2026-08-29T21:53:24.434Z` for `opencode-go/kimi-k3 / max`. The immediate session row projected `requestedModel=opencode-go/kimi-k3` and `requestedEffort=max` while retaining no `observedModel` or `observedEffort`.

The next provider turn completed at `2026-08-29T21:53:31.257Z`; the typed assistant row in OpenCode's isolated database records `opencode-go/kimi-k3 / max` at `2026-08-29 21:53:24 UTC`. A fresh authenticated client at `2026-08-29T21:54:16.403Z` preserved the requested pair, still without the observed pair.

The isolated server and daemon restarted from `2026-08-29T21:54:16.654Z` through `2026-08-29T21:54:19.295Z`. The post-restart provider turn completed at `2026-08-29T21:54:21.660Z`; its typed assistant row again records `opencode-go/kimi-k3 / max` at `2026-08-29 21:54:19 UTC`. At `2026-08-29T21:55:06.996Z`, the product row still had the requested pair and no observed pair.

The full machine-readable reading is in `opencode.json`. The defect is isolated to requested-versus-observed projection: the provider-side typed records prove both settings changed and persisted.
