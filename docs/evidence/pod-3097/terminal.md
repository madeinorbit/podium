# A11 generic PTY — exact-source unsupported control

- Issue: POD-3097, parent POD-1761
- Verdict: **PASS** — model/effort configuration refused with a typed terminal-specific reason and did not mutate the session.
- Cell start/end: `2026-08-29T22:11:18.052Z` / `2026-08-29T22:11:27.833Z`
- Source integration tip: `fbc2f18baf77d74d370c6469444b3c3d800b0a71`; during the cell the integration ref was docs-only descendant `62bb4a749241c7c7bd85fbca59e86a9651e4f4de`, with zero non-doc changes.
- Source trees: server `a6f3ff7c486789d88bd164019a305c83b447c0db`; daemon `db91eae2e746045aae924a056c36a10d8073ef30`; web `08a39cf1ae65ee5029e70c4c1d6574164500ad12`
- Served web: source `fbc2f18`, app `dev+fbc2f18`, wire `737208997d531cc3`, bundle `bundle+s8ci-irf`
- Isolated instance: `p3097-a11`; state root `/tmp/pod-3097-a11/state`; agent home `/tmp/pod-3097-a11/agent-home`; server/hook/relay ports `20097/47097/47098`; operator port `19797` untouched.
- Terminal arm: Codex explicitly selected on `generic-pty`; the driver advertised no configurable fields.

At `2026-08-29T22:11:22.301Z`, the independent native-PTY positive control requested geometry `113x37`; the live product row confirmed it at `2026-08-29T22:11:22.369Z`. No provider turn was driven in this control arm.

At `2026-08-29T22:11:22.443Z`, the product route refused model `terminal-control-model` plus effort `high` with `{reason:"unsupported", detail:"a TUI reads its model and effort from argv at launch; changing them is a relaunch"}`. Neither requested nor observed model/effort fields appeared immediately, after a fresh authenticated client at `2026-08-29T22:11:22.528Z`, or after the isolated server/daemon restart completed at `2026-08-29T22:11:26.563Z`.

The full machine-readable reading is in `terminal.json`.
