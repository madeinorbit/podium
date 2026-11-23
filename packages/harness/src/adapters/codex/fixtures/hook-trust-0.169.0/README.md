# Codex 0.169.0 hook trust (POD-6999)

Captured from real Codex 0.169.0 on a Linux test host, 2026-11-16. Each pair is a
`hooks.json` Podium's hook install wrote and the `config.toml` Codex saved after
"Trust all and continue" in its startup "Hooks need review" modal.

- `trust.*`: Podium's six handlers, nothing else.
- `matcher.*`: `PreToolUse` holds one group with `matcher = "Bash"`, a foreign
  handler at 0:0 and Podium's at 0:1.

Only the home folder in the `[hooks.state."<path>:…"]` keys was renamed to
`/home/user`; the `trusted_hash` values are as Codex wrote them (they do not
depend on the path). `instrumentation.test.ts` checks that
`codexLaunchHookTrustOverride` reproduces them byte for byte.
