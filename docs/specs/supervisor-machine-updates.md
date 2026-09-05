# Supervisor-owned machine updates

Status: implementation authorized by the user, 2026-09-05. Extends
[supervisor presence](supervisor-machine-presence.md). POD-3431; parent POD-3188.

## Ownership and audit

The server owns publication, explicit approval of an exact target, canary/widen policy,
reconnect eligibility, and operation aggregation. Reconnect compares the full frozen descriptor
as well as the version, so replacement bytes under the same version require new approval.
Publication is not approval. The
POD-3273 reconciliation rules remain authoritative; a reconnect must not substitute the
latest published target for the approved target.

The machine supervisor owns acceptance, serialization, download, verification, staging,
activation, child lifecycle, progress, and durable recovery. It has the same executor
whether its service assignment contains server, agent execution, both, or neither.
Transport and platform adapters may deliver commands or perform bounded installation
primitives; they must not independently select targets or run a second update workflow.

Audit: the original parent owns bundle swap and handover but server-local and daemon
participants still run grant workflows and write pending markers *after* swapping.
Standalone CLI repeats download/extract/swap. The native shell has a separate signed
installer. POD-2904 supplies supervisor enrollment and presence, but its runner still
signals itself through the old two-request swap/handover API. This implementation reuses
that presence work with original ancestry and replaces its execution seam.

## Authority and transports

An authenticated machine-plane connection delivers an `updateGrant` containing a grant
ID and the complete exact target (version, platform URL, digest, signature, trust root,
schema declaration). The executor freezes this descriptor on acceptance. A repeated ID
must name the identical descriptor; conflicting reuse is rejected. The additive `issuedAt` authority stamp is monotonic within a coordinator process;
older or equal stamps cannot supersede newer accepted authority. A backward clock jump
fails closed rather than silently reauthorizing old work. A deliberate downgrade requires fresh authorization;
version ordering alone neither grants nor revokes permission.

The supervisor stores its enrollment and pinned instance key in `supervisor.json`.
Publisher-advertised keys are diagnostic only. Release signatures use the baked release
key; instance signatures use the locally pinned key and the existing verified rotation
chain. A grant cannot replace either trust root.

Production fleet transport is the existing authenticated `/machine` WebSocket. Local
CLI/platform adapters address an instance-owned supervisor control socket. The Ubuntu
acceptance transport uses Unix-domain sockets for independently owned machine processes,
not several clients of one runtime. Socket paths and state roots are distinct per machine;
local control is restricted to the owning OS user. The transport authenticates the caller
before invoking the executor; parsing a grant is not authentication.

## Durable execution

A supervisor-owned journal under the instance runtime directory is written atomically
and flushed before destructive effects. It records the complete accepted grant, artifact
identity, previous running identity, phase, migration/rollback knowledge, and latest status.
Terminal results survive restart and are replayed on reconnect. Role processes do not
clear or overwrite supervisor execution state.

Transitions:

`accepted → downloading → prepared → activating → restarting → current`

Coordinator preparation can hold at `prepared` until its operation recovery snapshot is
durable. `/activate` must name that exact grant. The server never performs a local swap.

Pre-activation failure ends `rejected` with old services intact. Cancellation is accepted
before activation and aborts the download or discards staging. Once activation begins,
completion or recovery owns the machine; cancellation cannot leave a half-installed
bundle. Requests serialize across this boundary. Repeating a completed request replays
its outcome without another installation.

Staging verifies signatures and digest before extraction and validates the staged version
before replacing the live bundle. Activation retains the predecessor. Recovery reconciles
the journal against installed and *running* artifact identity; an installed VERSION file
alone is never proof that the replacement process is running. An interrupted download
may resume only the persisted exact grant, never re-resolve a rolling feed. An interrupted
activation restores a missing live directory from the retained predecessor or completes
the exact prepared replacement. Unknown or incompatible state fails visibly.

The existing parent child-stop/start, refusal handling, fenced successor takeover and
rollback policy remain the lifecycle authority. Rollback across new or unknown schema
migrations remains prohibited and produces a durable forward-fix reason. Health is
judged against configured roles. A zero-role supervisor must prove the successor's own
running identity; it must not wait for a nonexistent daemon or server.

## Topologies and platform boundary

| Machine | Coordinator transport | Local health proof | Execution owner |
| --- | --- | --- | --- |
| Server only | Supervisor to its own server | Exact successor and server identity | Supervisor executor |
| Daemon only | Supervisor to remote server | Exact successor and daemon identity | Supervisor executor |
| Server and daemon | Supervisor to local server | Exact successor and both services | Supervisor executor |
| Neither; desktop client | Supervisor to remote server | Exact successor; no role requirement | Supervisor executor |

Current desktop builds seed an external payload directory, so their supervisors advertise
payload delivery even when the desktop shell is the crash owner. This supersedes the older
presence spec exclusion for shell-embedded payloads; external payload and native shell
updates share one admission lock and journal. Client mode starts a zero-role parent.

Desktop native installation uses a platform adapter for its signed bundle and shell
restart. The shell services private `/native/work` commands and acknowledges bounded prepare and
activate effects; the supervisor owns their durable phases. Tauri verifies its configured
minisign signature during prepare. Restart is confirmed by the new shell version plus the
supervisor artifact receipt, never by an acknowledgement from the outgoing shell. The receipt is
fsynced before installation because platform installers can exit the shell inside that call;
it is authority evidence, and never proves success without the successor version. Recovery
uses the persisted URL/signature/version; obtaining the plugin verifier after a shell crash
currently requires its configured feed to be reachable. Payload and
native-shell identities remain distinct; they cannot be inferred from each other. The
Linux socket stand-in proves the shared executor and lifecycle protocol, not macOS bundle
replacement, Windows installer behavior, or a Tauri webview. Any unexercised native
boundary is reported precisely in the acceptance evidence.

The parent arms the existing desktop-death/shutdown-marker watcher before enrollment or
recovery can block. This includes zero-child parents: a shell crash drains the local
parent, and the next shell resumes the durable exact grant.

## Acceptance

A legacy CLI install without a live parent uses the same executor as a one-shot supervisor
and retains its documented manual restart contract. Older signed manifests without a
digest remain cryptographically bound by their exact signature; the verified archive is
then assigned a computed SHA-256 identity before staging.

Run checkout-local setup. At the completed candidate, run the lean admission gate,
`test:multi-instance`, and the focused supervisor process/socket lane sequentially under
the repository resource guards. The focused lane starts four distinct supervisors with
separate state, bundles, children and socket paths. Assert process identity, installed
artifact digest, durable results, child replacement and unaffected neighboring machines.

Cover coordinator self-update and remote delivery; offline catch-up to only approved
exact targets; no-daemon desktop; interrupted download and activation; supervisor restart;
invalid signature/digest, failed download, failed activation and rollback refusal;
pre-activation cancellation; progress and role availability; duplicate/idempotent requests;
stale authority and conflicting target reuse. Do not substitute mocked swap callbacks for
real signed archives, real process replacement, or socket-boundary assertions.

`test:native-machine-updates` then exercises a real Linux Tauri/WebKitGTK shell with
neither child role, using private signed debug ELF builds and a private HTTPS CA/feed.
It verifies native signature refusal without changing bytes, exact-grant recovery after
shell interruption, native installation, app restart, and the successor version plus
artifact digest. The display and D-Bus session outlive the old shell. This lane needs the
headless staging from `test:multi-instance`, Rust, OpenSSL, and Xvfb; it does not establish
AppImage packaging/FUSE, macOS bundle replacement, or Windows installer behavior.
