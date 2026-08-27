# POD-2871 — OpenCode transcript-isolation probe

Evidence plan updated: 2026-08-26 16:06:58 CEST

Probe controls updated: 2026-08-27 01:16:38 CEST

Terminal readiness control updated: 2026-08-27 02:02:08 CEST

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

The probe selects one exact store path for each arm; it never uses a fallback
that could turn a wrong path into an apparent isolation result. A wrong driver,
a missing store, a fault that does not fire, or a failed control is a non-zero
result and is not scored as a pass. The healthy companion's nonce must arrive
through the transcript API before the probe reads SQLite; otherwise the run is
NO_MEASUREMENT, not an isolation result. The session row must also report the
requested cwd, expected driver family, and the native OpenCode resume value.

The pre-fix control queries the legacy agent-home/.local/share/opencode/opencode.db
because that is the cwd-keyed store. The with-fix arm queries only the hashed
Podium-session-owned path selected by opencodeSessionDbPath; it never falls back
to the legacy path. Every row count records the native OpenCode session ID used

## Run later, when the box is quiet

Do not run this while another rig owns the same instance identity. Source the
POD-2811 environment. Run the pre-fix control on the exact parent first; it
must reproduce the leak before the with-fix arm is allowed to run:

```bash
. docs/evidence/pod-2777/drive-env.sh
P2777_REPO=/path/to/pod-2871-parent P2777_DRIVER=generic-pty bash docs/evidence/pod-2777/drive-up.sh
bun docs/evidence/pod-2777/drive-verify.sh 4a18e7d23
P2871_ARM=pre-fix P2871_EXPECTED_DRIVER=generic-pty P2871_EXPECTED_DRIVER_FAMILY=terminal bun docs/evidence/pod-2871/transcript-isolation.ts
```

Only after that control reports the leak, restart the same instance from the
fixed checkout and run the same probe:

~~~bash
P2777_REPO=/path/to/pod-2871-fix P2777_DRIVER=generic-pty bash docs/evidence/pod-2777/drive-up.sh
bun docs/evidence/pod-2777/drive-verify.sh <fixed-tip>
P2871_ARM=with-fix P2871_EXPECTED_DRIVER=generic-pty P2871_EXPECTED_DRIVER_FAMILY=terminal bun docs/evidence/pod-2871/transcript-isolation.ts
~~~

The default fault wait is 190 seconds, matching the existing POD-2811 watch;
override it with `P2871_FAULT_WAIT_MS` only when the measurement plan says to.
Evidence is written to `$PODIUM_DRIVE_BASE/transcript-isolation/result.json`.
Any missing positive control or identity pin is `NO_MEASUREMENT`, never a pass.
