# A11 Codex app-server — repaired current-tip cell

- Issue: POD-3097, parent POD-1761
- Verdict: **PASS** — model and effort applied on the next provider turn, projected as requested and observed, and survived client reload plus server/daemon restart.
- Cell start/end: `2026-08-29T22:54:22.296Z` / `2026-08-29T22:55:14.022Z`
- Exact integration tip and merge base: `71cb2b78855b32e445380b064040e8e9fe9784de`
- Repaired product source: `16c1c9c446bd67e8537884c725d9e8e4fabe5afa`; evidence head: `31c09aee6509a52f9263742c706375e97ec2149b`
- Source trees: server `d2f27572119d8f11837fd1242db249e5f80939a7`; daemon `46419367bb0d29df07a3b87cdee8a6412ae60fb4`; web `bf6d93251133d7eeabd664afdb5009333c34bc02`
- Served web: source `31c09ae`, app `dev+31c09ae`, wire `4c6f2e46828ec294`, bundle `bundle+yw8v15Ej`
- Isolated instance: `p3097-a11`; state root `/tmp/pod-3097-a11/state`; agent home `/tmp/pod-3097-a11/agent-home`; ports `20097/47097/47098`; operator port `19797` untouched.
- Harness: `codex-cli 0.150.1`; explicit driver `codex-app-server` advertised `model` and `effort`.

## Independent positive control

Marker `P3097-CODEX-CONTROL-RJSWBBX` was sent at `2026-08-29T22:54:26.650Z` and its exact provider reply was observed at `2026-08-29T22:54:30.456Z`.

## Apply, projection, and persistence

The real product configure route acknowledged `{ok:true,effective:"next-turn"}` at `2026-08-29T22:55:00.740Z` for `gpt-5.6-luna / max`. The immediate row projected the requested pair and no observed pair, preserving requested-versus-observed semantics before the next turn.

The next provider reply completed at `2026-08-29T22:55:03.286Z`; the row then projected both `requested=gpt-5.6-luna/max` and `observed=gpt-5.6-luna/max`. A fresh authenticated client at `2026-08-29T22:55:03.477Z` preserved both pairs.

The isolated server and daemon restarted from `2026-08-29T22:55:03.730Z` through `2026-08-29T22:55:08.887Z`. The post-restart provider turn completed at `2026-08-29T22:55:12.942Z` and the final row again projected both requested and observed as `gpt-5.6-luna / max`.

The full machine-readable reading is in `codex-repair.json`.
