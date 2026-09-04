# A1c main baseline

Measured 2026-08-27 07:27 CEST on instance `default` using the isolated default-ID rig at `/tmp/pod-2921`; the live `/home/mgw/.podium` default daemon was inventoried but not touched. The server, web bundle, and daemon were pinned to main `0bd90092c3a926b9305da34547fcc51b1e19b0a7`; see `docs/evidence/pod-2921/a1c-pin.json`.

Positive control: the baseline marker `P2874-A1C-CONTROL-MTB30E37` landed durably and received its reply. The probe then identified the exact live Claude child PID `1255774` in `/tmp/pod-2921/probes/claude-a1c`, sent `SIGKILL`, and confirmed that PID gone before the dead-session send.

The dead-session marker `P2918-A1C-DEAD-MTB3148Y` returned `{ok:true, queued:true, disposition:"queued"}`. No typed refusal or resume-and-send offer was returned, and the send was accepted after the exact child had been killed. Verdict: **FAIL** — matching the epic-side **FAIL**.
