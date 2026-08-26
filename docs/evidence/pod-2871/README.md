# POD-2871 — OpenCode transcript-isolation probe

This is the live measurement for the terminal-path defect where OpenCode's
directory-keyed store let a session with no assistant answer display a
neighbour's transcript. It is deliberately separate from the unit tests: the
probe creates real sessions against a running instance, reads the content over
the same transcript channel the UI consumes, and counts the matching rows in
the underlying OpenCode SQLite store.

## What it proves

The probe runs two cases on the terminal driver:

1. Two sessions in one directory. The healthy companion answers with a unique
   nonce and remains alive. The second session uses the retired
   `opencode/laguna-s-2.1-free` fault from POD-2811/POD-2604, which produces one
   user row and no assistant row. The probe asserts that its returned assistant
   content is empty, does not contain the companion nonce, and that its store
   has exactly one user message and zero assistant messages. It also asserts
   that the two sessions do not share a store.
2. Two healthy sessions in different directories. Each must return its own
   nonce and neither may return the other nonce; both stores must contain user
   and assistant rows.

The probe reads the session-owned path first and the legacy shared path only as
a diagnostic fallback, so a pre-fix run identifies the old store rather than
silently reporting “no rows”. A wrong driver, a missing store, a fault that
does not fire, or a failed control is a non-zero result and is not scored as a
pass.

## Run later, when the box is quiet

Do not run this while another rig owns the same instance identity. Source the
POD-2811 environment, bring up the terminal arm, verify the process pin, then
run the probe:

```bash
. docs/evidence/pod-2811/drive-env.sh
P2777_DRIVER=generic-pty bash docs/evidence/pod-2777/drive-up.sh
bun docs/evidence/pod-2777/drive-verify.sh HEAD
P2871_ARM=terminal bun docs/evidence/pod-2871/transcript-isolation.ts
```

The default fault wait is 190 seconds, matching the existing POD-2811 watch;
override it with `P2871_FAULT_WAIT_MS` only when the measurement plan says to.
Evidence is written to `$PODIUM_DRIVE_BASE/transcript-isolation/result.json`.
