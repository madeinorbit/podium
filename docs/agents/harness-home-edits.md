# Harness home edits

Launches record only applied edits in the person's own harness folder. The
bound command carries the context's home ownership to `prepareLaunch`, so
terminal, engine, turn and attach-client launches use the same rule. A context
with `harnessHome` writes no records. A value already present writes no record.

`apps/daemon/src/home-edit-service.ts` exposes the local request API:

- `listHomeEditRecords(harness?)` lists the stored records, including original
  values and canonical file paths.
- `removeHomeEditRecords(harness)` undoes one harness's recorded changes.
- `undoAllHomeEditRecords()` is the single machine-uninstall hook. Call it
  before deleting the instance's state folder and install ledger.

Undo returns one outcome per record: `restored`, `changed`, or `failed`.
Changed and failed outcomes include a reason and remain recorded for review or
retry. Successful outcomes delete their records. Undo checks that the file still
holds Podium's value and rereads it before writing. JSON undo restores only the
key; owned-file undo restores its exact previous text or removes a newly created
file; TOML undo removes one string and separator, retaining the other text.

The uninstall lifecycle does not exist yet; POD-7369 wires its cleanup to
`undoAllHomeEditRecords`. Ordinary daemon shutdown, restart, managed-binary
removal and repository removal must never call this hook. The install-request
and client wiring belongs to POD-7283.
