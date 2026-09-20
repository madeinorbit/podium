# Retained transcript archive ownership

Conversation storage outlives a running agent. Removing legacy PTY/session control
must retain the following services; none may require an `AgentRuntimeHandle`.
This is the E03/F10 prerequisite for POD-3744, tracked by POD-4301.

| Owner | Retained responsibilities |
| --- | --- |
| `packages/harness/src/discovery` and harness manifests | Discover native file and SQLite conversations, including externally launched runs; resolve native identity and recorded paths independently of process inventory. |
| `apps/daemon/src/discovery-loop.ts` and `control/discovery.ts` | Worker-owned discovery cache, periodic discovery and connect/manual full snapshots. Tail notifications accelerate discovery but do not replace the periodic scan. |
| `packages/harness/src/transcript-source.ts` | Native archive adapter: resolve file chains or SQLite from harness/resume identity, home and path evidence. No launch, attach or fabricated handle. |
| `apps/daemon/src/control/transcripts.ts` | Retained `transcriptRead` and `transcriptMirrorRead` transport. `TranscriptArchiveContext` permits only home configuration and replies, not live-agent services. Mirror ranges retain device/inode identity and discovery-root authorization. |
| Server memory module and conversation mirror store | Verbatim lake bytes, mirror cursors, immutable predecessor incarnations, index/search/cost consumers, and authorized path evidence. |
| `apps/server/src/modules/machines/rpc.ts` | Authorize the reader before accessing history; select live contract history versus native archive/lake history. A predecessor chain takes precedence even online; a disconnected daemon falls back to already mirrored bytes. |

`AgentRuntimeHandle.transcript.history` remains live-only. POD-4300 owns its server
routing integration: parked/offline reads and predecessor chains retain archive
routing. Runtime page envelopes and native archive item cursors are distinct;
source transitions must use its explicit native-anchor bridge or return a reset,
never reinterpret one cursor format as the other.

A moved workspace is not a new conversation. Recorded segment paths precede cwd
hints; missing/stale paths fall back to provider resolution by native identity.
A replacement inode is not permission to overwrite a predecessor. Preserve the
old incarnation and page the ordered chain through the server lake.

Without a daemon connection the server can read its existing lake and persisted
inventory. It cannot discover new bytes on an unreachable machine; native scans
resume when that machine is available, without starting any agent process.
Authorization still applies to offline reads. Native mirror paths must resolve
inside discovery roots, including after symlink resolution.

## Removal acceptance

Keep the native handlers and manifest readers until replacement services provide
all of these responsibilities. Moving their implementation is optional; deleting
them because they are outside the live contract is not.

Focused preservation evidence:

- `apps/daemon/src/control/transcripts.test.ts`: context without live services,
  moved/stale/absent paths, byte ranges and inode identity, symlink denial, full scan.
- `packages/harness/src/discovery/providers/opencode.test.ts`: real SQLite inventory
  without a CLI/process gate; Claude provider tests cover native file inventory.
- `packages/harness/src/transcript-source.test.ts`: native SQLite/file history.
- `apps/server/src/relay.lake-read.test.ts`: disconnected reads, online predecessor
  preference, immutable mirror rotation, indexing and reader authorization.
- `apps/daemon/src/discovery-loop.test.ts`: discovery continues on unchanged ticks.

The original removal-gap evidence is pinned to
`692d8c8e8f5465112dadeff50df0f0be817e9e51`; these owners are established against
`integration/3738-driver-contract`, not a change to the live-only driver scope.

## Validation on this issue branch

The lean gate was green: typecheck, span-effect lint and 135 tests in four
boot/configuration files. The focused native archive/discovery batch executed
40 passing tests across five files. The server lake file initially failed seven
fixture setups because its fake machine lacked an execution assignment; the
identical fixture repair from POD-4300 (`948942bae`) restored all eight passing
lake tests, including immutable mirror rotation and authorization.

POD-4300's contract routing tests were reviewed at `948942bae`, not executed on
this branch: that sibling change is not yet part of this candidate. The parent
must integrate both changes for the combined live/archive routing deliverable.
