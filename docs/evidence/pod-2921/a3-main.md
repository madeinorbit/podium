# A3 main baseline

Measured 2026-08-27 08:33 CEST on instance `default` using the isolated default-ID rig at `/tmp/pod-2921-a3`; the live `/home/mgw/.podium` default daemon was inventoried but not touched. The one-minute load gate was clear at 5.92. The server, web bundle, and daemon were pinned to main `0bd90092c3a926b9305da34547fcc51b1e19b0a7`; the shared probe used the fixed `rig.ts` from `8ba46c6fd2e98c0bba21c3ac3aad446e1772da84` (probe checkout `9f2c5ff3b80e099b570e140936aaafd8799a4459`). See `docs/evidence/pod-2921/a3-pin.json`.

Positive control: the unique marker `P2874-A3-MTB5D9VT` landed as a durable user turn. Independent in-flight proof: the PTY grew from 7,836 to 16,023 bytes and visibly rendered `line 1`, `line 2`, and `line 3`; the contradicted `phase` observer was not used to establish motion.

The interrupt returned `{ok:true}`. There was one residual second of PTY output (2,903 bytes), then zero growth for the remaining 19 one-second samples, establishing that the in-flight turn stopped. The transcript contains `[Request interrupted by user]`. `typedRefusal=false`, so the refusal-reason clause was not applicable: this was the acted-on interrupt path, evaluated by stop plus transcript marker.

Verdict: **PASS** — differs from the epic-side **FAIL**. A3 is therefore a main-to-epic regression and remains a release blocker.
