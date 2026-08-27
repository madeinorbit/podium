# A1b main baseline

Measured 2026-08-27 07:23 CEST on instance `default` using the isolated default-ID rig at `/tmp/pod-2921` (the live `/home/mgw/.podium` default daemon was inventoried but not touched). The server, web bundle, and daemon were all pinned to main `0bd90092c3a926b9305da34547fcc51b1e19b0a7`; the pin record is `docs/evidence/pod-2921/a1b-pin.json`.

Positive control: the first user marker `POD2921-A1B-FIRST-MTB2V060` landed durably. Independent in-flight control: terminal output grew by 2,375 bytes in the one-second interval immediately before the second send, while the first count-to-160 turn was still at numbers 156–159. The second marker `POD2921-A1B-QUEUED-MTB2V060` appeared as a user turn and assistant reply after the chat was closed and reopened.

The second send returned `{ok:true, disposition:"delivered"}` without a `queued` flag or numeric queue position. The terminal said only `queued messages`, with no position. Verdict: **FAIL** — matching the epic-side **FAIL**.

The shared phase observer reported `idle` throughout the long turn on main despite the independent terminal-growth control; that observer reading is retained in `docs/evidence/pod-2918/readings/main-a1b-final.a1b.json` as a blocked attempt. The scored result above uses the same busy-send interaction and the independent PTY-growth control to establish that the queue was actually exercised.
