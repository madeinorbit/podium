# Claude A3 current-tip non-reproduction

Measured 2026-08-27 10:06:33 CEST on named instance `p2924a3b`. The runtime checkout, server spawn pin, and daemon spawn pin were all `a010e6b88198bc8672e1c3292de554b35edcdcba` (commit time 2026-08-27 09:34:23 CEST). The one-minute load gate was 8.66 and `/` had 14 GB free.

The served web bundle was reused without editing its metadata. Its actual stamp remains `sourceSha=fb67ef2`, resolving to `fb67ef2278f083bf1bc7036186dea1e183dfcec6` (commit time 2026-08-27 05:51:23 CEST). The built source and runtime pin both resolve `apps/web` to tree `ee6ded230bf97196fafe2017b3b90e06a5cd5b64`; the stamp read from the served directory exactly matched the HTTP response. Full pin evidence is in `pins/parent-a3.json`.

The positive control fired independently of session phase: the unique durable user marker `P2924-A3-PARENT-MTB8PEWH` landed, PTY bytes grew from 7,029 to 11,569 across consecutive one-second samples, and the visible response reached `This is line 1.`. The shared phase observer was not used to establish in-flight motion or stopping.

`sessions.interrupt` returned `{ok:true,requested:"keystroke"}`. The PTY emitted one residual 529-byte sample, then 19 consecutive zero-growth samples; the visible count did not advance. The transcript recorded `[Request interrupted by user]`, and no typed-refusal path was exercised. Both acted-on clauses were evaluated: the turn stopped and the transcript marker was present.

Verdict: **PASS / regression not reproduced at the exact epic tip**. The issue brief requires stopping if the epic-side failure does not reproduce, so no product fix was made and no `[fix]` arm was driven.
