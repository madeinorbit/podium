# POD-2918 Claude current-pin redrive
<<<<<<< HEAD
Run completed on 2026-08-27 CEST before the 07:00 hard stop. This is the Claude column requested by POD-1761: all 15 rows have a current reading, with A4a/A4b left at the documented instrument limit and not retried.
## Rig and pin
- Named instance: p2918; base /tmp/pod-2918; ports 29181 / 46918 / 46919.
- Source, server launch SHA, and daemon launch SHA for every reading: 40c198eae5987da8cfa81ac20582ad9161d8270e.
- Web bundle for the original redrive: sourceSha 40c198e, wireVersion 2, wireSchemaDigest 986ebf5e8e57820c, built at 2026-08-27T01:52:00.954Z, bundleVersion bundle+BN6ReJPR. The A1c follow-up rebuilt and served the same exact pin at 2026-08-27T04:30:53.133Z.
- The daemon was restarted during A7a; its post-restart pin matched the same source SHA. Runtime contract was enabled. Pin records had no forbidden state/home/socket/web overrides.
- Each cell reused the POD-2874 positive-control design and was run sequentially after a date, df -h /, load, credential-mtime, and exact server/daemon pin check. Root availability was 13–16 GB; the rig footprint measured 212 MB plus 242 MB agent home.
## Current results
=======
 
Run completed on 2026-08-27 CEST before the 07:00 hard stop. This is the Claude column requested by POD-1761: all 15 rows have a current reading, with A4a/A4b left at the documented instrument limit and not retried.
 
## Rig and pin
 
- Named instance: p2918; base /tmp/pod-2918; ports 29181 / 46918 / 46919.
- Source, server launch SHA, and daemon launch SHA for every reading: 40c198eae5987da8cfa81ac20582ad9161d8270e.
- Web bundle: sourceSha 40c198e, wireVersion 2, wireSchemaDigest 986ebf5e8e57820c, built at 2026-08-27T01:52:00.954Z, bundleVersion bundle+BN6ReJPR.
- The daemon was restarted during A7a; its post-restart pin matched the same source SHA. Runtime contract was enabled. Pin records had no forbidden state/home/socket/web overrides.
- Each cell reused the POD-2874 positive-control design and was run sequentially after a date, df -h /, load, credential-mtime, and exact server/daemon pin check. Root availability was 13–16 GB; the rig footprint measured 212 MB plus 242 MB agent home.
 
## Current results
 
>>>>>>> 73b46bd2b (Record Claude current-pin redrive)
| Cell | Verdict | Current observation | Read at | Root free |
|---|---|---|---|---|
| A1a send while idle | PASS | 3/3 durable sends replied; last send landed | 05:22:39 | 13 GB |
| A1b send while busy | FAIL | busy control fired; second receipt was queued=true with no position; reload then delivered user and reply | 05:25:08 | 13 GB |
<<<<<<< HEAD
| A1c send to a dead session | FAIL | exact child PID 1186968 was SIGKILLed and confirmed gone; queued send had no assistant reply after 120.036s and the row exited with resume=null | 06:43:11 follow-up | 15 GB |
=======
| A1c send to a dead session | FAIL | exact child PID 1023334 was SIGKILLed and confirmed gone; dead send was silently accepted as queued | 05:31:01 | 13 GB |
>>>>>>> 73b46bd2b (Record Claude current-pin redrive)
| A2a status while working | PASS | working at 45 ms, no idle samples during the 15 s sample, then idle | 05:32:33 | 13 GB |
| A2b status at boot | PASS | fresh session attached and reported idle | 05:34:21 | 13 GB |
| A3 interrupt mid-turn | FAIL | load gate was 3.83; working control fired; interrupt returned a keystroke request but no stopping record within 20 s | 05:36:08 | 13 GB |
| A4a permission ask | BLOCKED | claude-code 2.1.231 rewrites permissions.defaultMode manual-to-auto; not retried | 05:37:49 | 15 GB |
| A4b answer twice | BLOCKED | same documented instrument limit; not retried | 05:38:11 | 15 GB |
| A5 transcript | PASS | non-sensitive test marker produced a tool/result pair and identical transcript after reload | 05:40:18 | 15 GB |
| A6a terminal attach | PASS | two native viewers saw the echo; resize became 100x30 and replayed | 05:41:48 | 15 GB |
| A6b chat/CLI switch x2 | PASS | chat-to-CLI-to-chat-to-CLI retained one live session and both views worked | 05:43:25 | 15 GB |
| A7a daemon restart | PASS | same conversation and codeword survived; post-restart daemon pin matched | 05:45:48 | 15 GB |
| A7b hibernate/wake | PASS | hibernate/wake preserved the conversation and answered after wake | 05:47:19 | 15 GB |
| A8 logged-out spawn | BLOCKED | after trust priming, Not logged in /login was visible; external OAuth was not completed | 05:50:50 | 15 GB |
| A9 kill session | PASS | exact target tree was empty immediately and after five minutes | 05:51:52 | 15 GB |
<<<<<<< HEAD
The post-A9 PID-to-cwd sweep at 05:58:54 found only the original redrive server (735180) and daemon (1055674); the follow-up final sweep at 06:48:33 found no p2918 rig CWDs, agent, or orphan server. No pgrep -f was used.
The A1c persistence follow-up at 06:43:11 is the disambiguating observation: the baseline user/reply control fired, exact Claude child PID 1186968 was killed and confirmed gone, and sessions.sendText returned {ok:true, queued:true, disposition:queued}. After the send the row was exited with resume=null; the assistant needle never arrived in 120.036s. This is a lost message, so A1c remains FAIL. The initial reading is preserved as claude.a1c-initial-fail.json; the inherited-PODIUM_WEB_DIR pin refusal is preserved as claude.a1c-followup-pin-refused.json.
## Setup and safety notes
The first fresh probe paths exposed compact-rendered trust/auto-mode onboarding labels. The established primeTerminalTui routine was extended to recognize those labels, then the affected readings were rerun with the modal cleared; the readings listed above are the authoritative primer-backed results. A5 uses a non-sensitive test marker rather than a fixture called “secret”; its tool-pairing and reload criterion is unchanged.
The operator credential was never printed or returned. The source file /home/mgw/.claude/.credentials.json was observed with expiry 2026-08-27 07:43:12 CEST and mtime 2026-08-26 23:43:12.934567283 +0200, size 962. The temporary rig copy was used only while unexpired, and was deleted during final teardown.
Final teardown completed at 2026-08-27 06:48:33 CEST: verified p2918 server/daemon stopped, the temporary agent home and source worktree were removed, no rig credential-copy paths remained, and / had 16 GB free. Final source credential mtime remained 2026-08-26 23:43:12.934567283 +0200, size 962; final expiry remained 2026-08-27 07:43:12 CEST.
=======
 
The post-A9 PID-to-cwd sweep at 05:58:54 found only the rig server (735180) and daemon (1055674) under the p2918 source path; no agent or orphan server remained. No pgrep -f was used.
 
## Setup and safety notes
 
The first fresh probe paths exposed compact-rendered trust/auto-mode onboarding labels. The established primeTerminalTui routine was extended to recognize those labels, then the affected readings were rerun with the modal cleared; the readings listed above are the authoritative primer-backed results. A5 uses a non-sensitive test marker rather than a fixture called “secret”; its tool-pairing and reload criterion is unchanged.
 
The operator credential was never printed or returned. The source file /home/mgw/.claude/.credentials.json was observed with expiry 2026-08-27 07:43:12 CEST and mtime 2026-08-26 23:43:12.934567283 +0200, size 962. The temporary rig copy was used only while unexpired, restored after A8, and deleted during final teardown.
 
Final teardown completed at 2026-08-27 06:05:45 CEST: verified p2918 server/daemon stopped, the temporary agent home and source worktree were removed, no rig credential-copy paths remained, and / had 14 GB free. Final source credential mtime remained 2026-08-26 23:43:12.934567283 +0200, size 962; final expiry remained 2026-08-27 07:43:12 CEST.
>>>>>>> 73b46bd2b (Record Claude current-pin redrive)
