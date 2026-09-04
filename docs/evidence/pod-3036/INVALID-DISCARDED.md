# Invalid run — discarded 2026-08-28 13:46 CEST

The 2026-08-28 13:00–13:40 CEST p3036 drive is invalid and must not be scored.

- Spawn pin was stale `cb4f19a0e`. Epic tip then and now is `c71b896a9`.
- At 2026-08-28T11:01:25Z the rig copied an unexpired live Claude credential
  into `/home/mgw/.local/state/podium/p3036/agent-home/.claude/`.
- Isolated copy deleted 2026-08-28T13:42:39+02:00. No backup remained.
- Live credential mtime stayed `2026-08-28 08:20:34.463741791 +0200`, size 962.
- 36 results.tsv rows from `1c5ffa542` were removed; TSV matches `c71b896a9`.
- Pin files, readings, and `seed-credential.sh` were deleted. Do not mix this
  run with any later no-copy drive.
