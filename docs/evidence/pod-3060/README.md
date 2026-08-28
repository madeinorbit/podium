# Live A6b verification — OpenCode switch fix

This is the post-landing real-instance verification of `b5a3aa870`
(*Park the OpenCode CLI instead of killing it on a view switch*). It drives the
canonical A6b sequence on a named `opencode-server` session at the current epic
tip. It does not edit `docs/plans/pod-1761-results.tsv`.

## Required scoring

Every clause is scored independently:

| clause | score |
| --- | --- |
| both directions twice | pending |
| no restart | pending |
| no scrollback corruption | pending; `UNMEASURED` is required if the instrument cannot measure it |
| correct size | pending |
| chat still answers after switching | pending |
| CLI still echoes after switching | pending |

The positive control must fire before the switches. A missing control refuses the
measurement; it is not a failure. The defining comparison is the pre-fix
OpenCode reading at `5fe951f2f`, where the CLI echo failed after both switches.

## Run record

To be filled from the pinned live drive:

- named instance: pending
- product pin: pending
- driver and binary: pending
- session: pending
- control: pending
- clause-by-clause result: pending

