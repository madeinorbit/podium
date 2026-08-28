# POD-3036 Claude SDK vs PTY acceptance

The 13:00–13:40 CEST `p3036` run is invalid. See `INVALID-DISCARDED.md`.

## Valid no-copy drive (p3036n)

- Pin: `c71b896a9504426ee6706a0623e9cb25e704cc98`
- Instance `p3036n`, ports 19946/46946/46947, TOS=1, explicit runtimeContract
- Isolated `.credentials.json` absent before every cell
- Live credential mtime unchanged: `2026-08-28 08:20:34 +0200` size 962
- SDK replies used the daemon's existing operator account-home (no copy)
- PTY in the isolated home stayed logged out (`Not logged in /login`)

| Cell | claude-sdk | claude-pty |
|---|---|---|
| A1a | PASS | FAIL (errored, class unknown, not quota) |
| A1b | PASS (queue position 1) | not driven (logged-out) |
| A1c | no-control, discarded | not driven |
| A2a | PASS | not driven |
| A2b | PASS | PASS |
| A3 | FAIL (stopped, no transcript marker) | not driven |
| A4a/A4b | BLOCKED (no ask) | not driven |
| A5 | BLOCKED (`sessions.read` empty) | not driven |
| A6a | no-control, discarded | PASS |
| A6b | FAIL (no CLI) | not driven |
| A7a/A7b | PASS/PASS | not driven |
| A8 | FAIL (bound, no login path) | BLOCKED (login path visible) |
| A9 | PASS (probe argv only) | not driven |
| A10 | PASS `claude-sdk` | PASS `claude-pty` |
| B quota | PASS (class none) | BLOCKED (authentication, not quota) |

Reds: SDK A8, SDK A3, SDK A6b, PTY A1a.
