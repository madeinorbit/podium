# OpenCode A7a cold-start driver blocker

Recorded from the fifth wholly fresh exact-tip attempt. The product bytes were pinned to `4fd5a05b6`; the repaired evidence branch was pinned to `4409c5965`, descended from exact local epic tip `9e90aed68aaed800bba6f074ff5060272de2c808`.

The named instance was `p3112-a7a-proof-0830e` on ports `20451`, `47451`, and `47452`, with fresh base `/tmp/pod-3112-a7a-proof-20260830-5` and initialized dummy repository `dummy-r18-proof5`. The served web bundle reported `sourceSha=4fd5a05`, the daemon and server spawn pins were `4fd5a05b6`, and OpenCode was `1.18.25` with SHA-256 `d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb`.

The cold-start UI structurally selected OpenCode and created exactly one session at `2026-08-30T11:45:16.177Z`:

- session id `bd81d9c8-7e54-4704-a576-30277530556e`
- account `native:opencode`
- cwd `/tmp/pod-3112-a7a-proof-20260830-5/dummy-r18-proof5`
- `driverId=generic-pty`
- `driverFamily=terminal`
- `neverBound=true`

The required explicit experimental `opencode-server` choice was not available or used on this cold-start path. The identity positive control fired, but the required driver control did not; the runner refused before its seed prompt, so provider prompts were exactly zero and A7a was not scored.

No harness-authored runtime override or direct API bypass was used. No A7b action occurred. The instance, server, daemon, isolated credential symlink, and owned processes were fully torn down at `2026-08-30T13:47:32+02:00`; operator/default state and forbidden ports were untouched.

This is a user-visible per-session driver-selection blocker: the selected OpenCode cold-start action bound the default generic PTY instead of offering or using the explicit experimental server driver required for A7a.
