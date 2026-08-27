# A3 main baseline

Attempted 2026-08-27 07:34–07:35 CEST on instance `default` using the isolated default-ID rig at `/tmp/pod-2921`; the live `/home/mgw/.podium` default daemon was inventoried but not touched. The load gate was clear at 5.26 for the one-minute average. The server, web bundle, and daemon were pinned to main `0bd90092c3a926b9305da34547fcc51b1e19b0a7`; see `docs/evidence/pod-2921/a3-pin.json`.

The shared A3 probe was bounded by the credential safety cutoff. It emitted the pin at 07:34:51 CEST but timed out before the Claude session and positive durable-turn control produced a reading; the remaining Claude child was terminated during teardown. Therefore there is no valid PASS/FAIL observation for interrupt behavior.

Verdict: **UNDRIVEN** — no positive control fired before the 07:35 cutoff. This is not comparable to the epic-side **FAIL**; it neither establishes a match nor a difference.
