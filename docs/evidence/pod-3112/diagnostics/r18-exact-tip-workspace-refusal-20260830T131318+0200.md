# OpenCode exact-tip workspace refusal

Recorded 2026-08-30T13:13:18+02:00. Integration, origin, and the issue branch were exact at `724704deb5c10665729fe3d631e363978a24470b`; the product tree remained pinned to repair `4fd5a05b6b1a80f89494377400a5207271eed198`.

The resumed A7a drive is **REFUSED and unscored** because the workspace positive control did not fire. The coordinator-provided rootless Chromium library path fixed browser launch, but the committed driver could not find exactly one visible `dummy-repo` workspace row within 30 seconds in either of two wholly fresh isolated instances. Both runs ended before session creation; provider prompts were `0`, so no A7a PASS/FAIL verdict or acceptance-ledger row is valid.

Attempt one used instance `p3112-a7a-final-1120`, ports `21527`/`48527`/`48528`, and `/tmp/pod-3112-a7a-final-20260830t1120z/dummy-repo`; it launched at 2026-08-30T13:10:34+02:00 and was torn down at 13:11:53+02:00. Attempt two used an initialized repository with a seed commit, instance `p3112-a7a-final-1130`, ports `21561`/`48561`/`48562`, and `/tmp/pod-3112-a7a-final-20260830t1130z/dummy-repo`; it launched at 13:12:14+02:00 and was torn down at 13:13:18+02:00.

For both attempts, server and daemon boot pins were `4fd5a05b6b1a80f89494377400a5207271eed198`, the served web stamp was `dev+4fd5a05`, and OpenCode was version `1.18.25` at SHA-256 `d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb`. Product-derived named state, fresh ports/base/repo, capacity, repository registration, approved credential symlink posture, browser launch, and teardown controls passed. Both credential symlinks were deleted, matching processes were absent after teardown, A7b was not attempted, and no credential bytes were read or copied.
