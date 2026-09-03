# POD-3037 — Grok A4 permission drive

Written 2026-08-28 13:57:00 CEST. This is the current-tip re-drive of the
Grok A4 cells that were instrument-blocked at c26c267be. The probe was
driveable: the real grok-acp driver bound and both positive controls fired, so
the readings below are verdicts rather than undriveable observations.

## Verdict

- A4a permission ask: PARTIAL. Chat enumerated a structured permission ask,
  and the native terminal showed the same ask before the answer, but the native
  terminal still looked to be prompting after the answer. The required
  both-planes criterion is therefore unmet.
- A4b answer twice: PASS. The first allow-once returned ok:true, removed the
  ask from the open set, and caused exactly one side effect. The second answer
  returned a typed already-answered refusal and caused no second execution.
- Positive controls: FIRED. The turn produced 3 transcript items and 3 delta
  frames. The first-answer control also fired: success, resolved ask, and one
  execution. No no-control run is reported as a verdict.

## Provenance and pins

| item | value |
| --- | --- |
| historical blocked pin | c26c267be1c4b2f8cc6ccc2e66ea675e84024587 |
| epic tip before this probe | 182d00fc3d14ec029d394952270cd6193c3a9388, 2026-08-28 13:14:21 +0200 |
| drive / spawn commit | fe311c5def391808884aa9c1c736d84ee0de3180, 2026-08-28 13:46:08 +0200 |
| server, daemon, served web | all spawned or stamped at fe311c5 |
| instance | pod3037g |
| API | 127.0.0.1:19847 |
| arm | CONTRACT=1, STREAMING=1, DRIVER=(policy) |
| bound driver | grok-acp, family server |
| Grok binary | /home/mgw/.local/bin/grok — grok 0.2.118 (1e1687c1cf) [stable] |
| server / daemon PIDs | 543419 / 543689 |
| session | d6c40611-0227-4c47-bb25-e74ad20c9c59 |
| served bundle sourceSha | fe311c5 |

The pin verifier reported exactly one daemon on the named instance, both
processes from this worktree at fe311c5, a served bundle sourceSha of fe311c5,
and the requested arm. The product tree was clean outside the probe's own
docs/evidence path. No main branch merge was performed.

## Epic movement after the drive

At drive time the local epic tip was 182d00fc3d14ec029d394952270cd6193c3a9388.
After this drive, the local issue/1761-agent-runtime ref advanced to
bf328f859b5bfee724a68745ad85561e61bc3235. The non-doc drift between those pins
is confined to Claude SDK and session-model changes; it does not touch Grok
ACP, permission, terminal, or shared A4 probe paths.

The reading remains pinned to fe311c5 and is not being relabeled as a current
tip drive. This is the standing-brief case where the branch moved in an area
outside the measured cell.

The host preflight at 2026-08-28 13:47:27 CEST showed 19,674 MiB available
memory, 281 MiB swap used, and quiet swap samples. The server boot log began at
2026-08-28 13:50:02.476 CEST; the raw probe reading was captured at
2026-08-28 13:52:31.527 CEST.

## Scored run

Raw reading: readings/grok-a4-fe311c5de.txt

The probe created this unique session cwd:

/home/mgw/pod-3027-a4-never-approved-1787917904724-cwd-q3zpji/repo

It was under HOME, outside every listed Codex or Grok trusted root, and outside
/tmp and /var/tmp. The session cwd was therefore not an already-trusted
workspace.

### A4a chat plane

The open interaction was:

- kind=permission, id=0
- source=protocol, answerable=structured
- enumerable=yes: interactions.list carried it while open
- toolName=Bash, canAlwaysAllow=false
- open asks=1

This is the required structured chat ask.

### A4a native terminal plane

The native view was attached only after the structured ask was enumerable.

- terminal bytes before answering: 6624
- outputSeen=false
- permission wording present: true
- unique command marker TOOLRAN-1YRHDS present: true
- tool name Bash present as supporting text: true
- same ask visible before answering: true
- after the first answer: +44 bytes
- same ask still prompting after answering: true

The terminal therefore showed the ask before the answer, but did not show that
the ask had stopped prompting afterward. This is PARTIAL, not PASS; the chat
half cannot be used to call the A4a cell green.

### A4b first and second answers

First answer:

- request: permission / allow-once
- returned: {"ok":true}
- open ask: left the open set
- side effect: exactly 1 execution, TOOLRAN-1YRHDS.txt
- first-answer classifier: not a refusal

Second answer to the same ask:

- returned: {"ok":false,"reason":"already-answered"}
- typed refusal: true
- silent success: false
- execution count: 1 before and 1 after

This is PASS: the first answer genuinely succeeded and acted once, while the
second answer was refused without a second action.

## Grok posture isolation

Grok's auto-approve equivalent was identified as the native config setting
[ui] permission_mode = "always-approve" in ~/.grok/config.toml. The named
daemon instance uses the isolated agent home, so the probe changed only:

/home/mgw/.local/state/podium/pod3037g/agent-home/.grok/config.toml

The isolated config was absent before the run. The probe wrote
permission_mode=ask, logged that the operator config was not touched, and
restored the isolated config to absent on exit. A post-run check still found
the operator config at permission_mode=always-approve; its SHA-256 was
02862a01ec97555ca194fc9b0f1687bf8d5e25c499bd7a4e96af9e6ab6bbb8c0. The
restoration arm is registered before mutation and restores exact prior bytes
or absence.

The probe also reads Grok's trusted_folders.toml alongside Codex's project
config and refuses a dummy cwd under a known trusted root. No operator config
was edited.

## Startup and scope notes

The first detached startup attempt was not a scored cell: this command runner
reaped the background pair after the startup shell ended, and the pin verifier
correctly refused dead recorded PIDs. The scored run kept startup, pin
verification, and probe in one persistent shell. The named root's guard-created
empty runtime/tmux directories also required the existing intentional
PODIUM_ADOPT_STATE=1 first-run adoption path; no fabricated marker or product
path override was used.

The probe source change is in docs/evidence/pod-2777/a4.ts. The later evidence
commit only hardens the restoration arm before the isolated write and corrects
its dummy-repo description; the scored server, daemon, and probe were spawned
at the drive commit above.

This cell was driveable, so a main-equally-undriveable comparison is not
applicable. docs/plans/pod-1761-results.tsv was not edited; the coordinator
should transcribe these verdicts.

