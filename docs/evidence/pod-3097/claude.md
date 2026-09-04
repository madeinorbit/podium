# A11 Claude SDK — exact-tip cell

- Issue: POD-3097, parent POD-1761
- Verdict: **FAIL** — the next turn changed model, but native effort observation was absent and restart persistence failed while Podium still showed the requested pair.
- Cell start/end: `2026-08-29T21:56:33.544Z` / `2026-08-29T21:58:55.758Z`
- Exact integration tip and merge base: `fbc2f18baf77d74d370c6469444b3c3d800b0a71`
- Source trees: server `a6f3ff7c486789d88bd164019a305c83b447c0db`; daemon `db91eae2e746045aae924a056c36a10d8073ef30`; web `08a39cf1ae65ee5029e70c4c1d6574164500ad12`
- Served web: source `fbc2f18`, app `dev+fbc2f18`, wire `737208997d531cc3`, bundle `bundle+s8ci-irf`
- Isolated instance: `p3097-a11`; state root `/tmp/pod-3097-a11/state`; agent home `/tmp/pod-3097-a11/agent-home`; server/hook/relay ports `20097/47097/47098`; operator port `19797` untouched.
- Harness: installed Claude Code `2.1.236`; embedded SDK transcript version `2.1.201`; driver `claude-sdk` advertised `model` and `effort`.

## Independent positive control

At `2026-08-29T21:56:37.186Z` the product sent marker `P3097-CLAUDE-CONTROL-VI0MDKI`; the provider's exact reply was observed at `2026-08-29T21:56:43.000Z`. Claude's native assistant record at `2026-08-29T21:56:42.019Z` records the baseline model `claude-opus-4-8`.

## Apply, projection, and persistence

The product control route acknowledged `{ok:true,effective:"next-turn"}` at `2026-08-29T21:57:13.539Z` for `claude-opus-5 / max`. The immediate session row projected `requestedModel=claude-opus-5` and `requestedEffort=max` while retaining no `observedModel` or `observedEffort`.

The next provider turn completed at `2026-08-29T21:57:16.825Z`; Claude's native assistant record at `2026-08-29T21:57:16.115Z` proves the model changed to `claude-opus-5`. The SDK host passed `effort=max`, but the native assistant record did not stamp an effort field, so the required provider-side effort observation cannot be proved. A fresh authenticated client at `2026-08-29T21:58:02.032Z` preserved the requested pair, still without an observed pair.

The isolated server and daemon restarted from `2026-08-29T21:58:02.286Z` through `2026-08-29T21:58:06.218Z`. Claude's native transcript warned at `2026-08-29T21:58:08.034Z` that session model `claude-opus-5` could not be restored and it would use the default. The post-restart assistant record at `2026-08-29T21:58:09.073Z` proves the provider fell back to `claude-opus-4-8`, while Podium retained the requested `claude-opus-5 / max` pair and no observed pair through `2026-08-29T21:58:54.817Z`.

The full machine-readable reading is in `claude.json`. This cell exposes both missing requested-versus-observed projection and a native Claude SDK restart fallback hidden by the requested projection.
