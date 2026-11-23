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

The Codex and Grok hook installs (`~/.codex/hooks.json`,
`~/.grok/hooks/podium.json`) write their files themselves, outside
`prepareLaunch`. Each install reports the file in `InstalledInstrumentation.hookFile`.
The daemon's runtime host passes it to `recordInstrumentationHookFile`, which
records a `hook-handlers` change for a file in the person's own folder.
Handlers an older Podium left there with no record are recorded on the next
launch, with the file minus those handlers as the prior. Undo takes out only the
handlers whose command contains the record's marker, plus groups and event
lists that held nothing else. It writes the exact prior bytes when nothing else
in the file changed, and removes a file Podium created once nothing else is in
it. Hooks the person added since stay. A file the person deleted drops its
record.

When Podium creates a missing file, an absent prior also names the outermost
folder Podium created for it (`createdFolder`). After undo removes that file,
it removes the folders from the file's own folder up to that one, each only
while it is empty. A folder the person put something in stays, and so does
every folder above it. A folder that existed before is never recorded.

Two callers use the hook, and both are uninstalling Podium from the machine:

- `podium uninstall` (`apps/cli/src/uninstall-cli.ts`, the undo injected by
  `scripts/cli.ts`) stops the services and sessions, runs the hook, removes the
  service units, and removes the state folder, the installed bundle and its
  command only when every outcome is `restored` (or with `--force`). On a server
  or all-in-one instance the state folder holds the workspace database and is
  kept unless `--delete-workspace-data` is given too.
  It refuses, with no override, while the desktop app runs the instance
  (`<state>/desktop-supervised`, kept by the run registry): the person
  uninstalls the app instead.
- The machine menu's "Uninstall Podium" (`machines.uninstall`, a
  `machine.uninstall` effect record) sends `machineUninstallRequest` to the
  daemon (`apps/daemon/src/control/uninstall.ts`). The daemon runs the hook,
  answers with the outcomes, and starts `podium uninstall --yes` outside its own
  service; the server then revokes the machine. It is refused for the machine
  that runs the server, a desktop-supervised daemon, and a daemon that does not
  offer `machine.uninstall.v1`.

Ordinary daemon shutdown, restart, managed-binary removal, repository removal
and the Settings "Remove machine" revoke must never call this hook. The install-request
and client wiring belongs to POD-7283.
