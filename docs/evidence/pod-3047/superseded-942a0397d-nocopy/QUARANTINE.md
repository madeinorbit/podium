# HISTORICAL — do not read these as current

Readings at pin `942a0397dd0d30614d5424061a27cdc95c8a460e`, 2026-08-28
17:58–18:30 CEST, credential posture ABSENT. **Superseded** by
`readings-symlink/` and `readings-absent/` at pin `ad02520c2`.

This is the set that established two things worth keeping:

- **POD-3057's fix works.** `sessions.read` went from empty to returning the
  conversation, and the JSONL moved to the instance agent home.
- **And that it makes a credential-free rig logged out**, which is what forced
  the posture decision. Most SDK cells here are BLOCKED-on-auth for exactly that
  reason, and A8 became drivable for the first time.

It also contains the false PASS that led to the permission-kind fix: A4a and A4b
scored green off `kind: 'login'` interactions on a session that never ran a tool.
