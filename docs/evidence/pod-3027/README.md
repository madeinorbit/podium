# POD-3027 — Codex A4 dummy-repo approval drive

Written 2026-08-28 12:08:59 CEST. Times below are from `date` and
`git show -s --format=%ci`, not estimated.

## Provenance

| pin | SHA | commit time | what was driven |
| --- | --- | --- | --- |
| epic tip | `45323df366cb9ac7156f7d1b4c02c39c706aaf33` | 2026-08-28 10:07:21 +0200 | product tree; non-docs diff to the drive pin is empty |
| drive / spawn | `be0334e77b1d82cb27b3df991429359f31048682` | 2026-08-28 11:53:19 +0200 | dummy-cwd probe commit; server, daemon, web all spawned/stamped here |
| web bundle | sourceSha `be0334e` bundle `bundle+CN6nLh43` | builtAt 2026-08-28T09:55:05.190Z | served from :19927 `/podium-build.json` |
| Codex binary | `codex-cli 0.149.1` at `~/.codex/packages/standalone/releases/0.149.1-x86_64-unknown-linux-musl/bin/codex` | n/a | first on the daemon PATH after a restart; 0.150.1 is outside app-server range |

Canonical verifier: instance `cx3027`, server pid 121777, daemon pid 125774,
port 19927, arm CONTRACT=1 STREAMING=1 DRIVER=(policy). Recorded in
`readings/verify.txt` and `readings/verify-pre-a4.txt`.

`PODIUM_ADOPT_STATE=1` was used only to adopt `runtime/tmux` directories the
product had just created. No `HOME`, `PODIUM_STATE_DIR`, `ABDUCO_SOCKET_DIR`,
or `PODIUM_RUNTIME_DRIVER` override.

## Windows

| window (CEST) | event |
| --- | --- |
| 11:54:03 | admission: 99 GiB free, swap used 0, si/so 0 |
| 11:54:36–11:55:09 | web bundle built at be0334e (no test:heavy lock; lock was free) |
| 11:56:18–11:56:22 | named instance `cx3027` up |
| 11:57:08 | daemon restarted with Codex 0.149.1 first on PATH |
| 11:57:31–11:57:32 | three-part pin verified |
| 11:57:43–11:58:29 | run 1: dummy cwd, isolated `auto_review` left in place |
| 12:00:40–12:02:02 | run 2 (scored): dummy cwd + isolated `approvals_reviewer=user` restored on exit |
| 12:02:51–12:08:08 | run 3 discarded: 90s native wait hit a websocket TimeoutError; not a result |
| 12:08:43–12:08:59 | teardown; server 121777 and daemon 125774 stopped |

Nothing was driven against later epic tips; `issue/1761-agent-runtime` stayed
at `45323df36` for the whole drive.

## Results

Positive control fired on every scored run (transcript items and delta frames).
No run without a fired control is reported as a cell verdict.

### Run 1 — dummy never-approved cwd, `auto_review` still copied

Reading: `readings/a4-codex-auto-review.txt`

- Session cwd: `/home/mgw/pod-3027-a4-never-approved-1787911063763-cwd-on8dn4/repo`
  (unique tree under `$HOME`, not under any previously trusted project, not under `/tmp`)
- Driver: `codex-app-server` (family server)
- Control: 4 items, 4 frames — FIRED
- A4a **BLOCKED** — Bash ran with no enumerable structured ask
- A4b **BLOCKED** — no ask to answer twice

The never-approved dummy Git cwd is necessary and not sufficient. Isolated
`approvals_reviewer=auto_review` still auto-answers, so Podium never sees the
ask. After this run Codex wrote that dummy path into the isolated
`config.toml` as trusted; the operator `~/.codex/config.toml` was not modified.

### Run 2 — dummy cwd + isolated reviewer `user` for this probe only (scored)

Reading: `readings/a4-codex-user-30s.txt`

Isolated `approvals_reviewer` was switched to `user` for the probe and restored
to `auto_review` on exit (same shape as A4's opencode `permission.bash=ask`
posture). Operator config was not touched.

- Session cwd: `/home/mgw/pod-3027-a4-never-approved-1787911240987-cwd-ucaucy/repo`
- Driver: `codex-app-server` (family server)
- Control: 2 items, 2 frames — FIRED
- Structured ask: kind=permission, id=0, source=protocol, toolName=Bash, enumerable
- First answer `allow-once`: `{ok:true}`, ask left the open set, **exactly 1** side-effect execution
- Second answer: `{ok:false, reason:"already-answered"}` typed result, **not** a double action
- Classifier control: first answer is not a refusal — FIRED

**A4a PARTIAL** — chat half PASS; terminal half did not show the ask before
answering (0 native bytes, outputSeen=false). After the answer the TUI grew
+6268 bytes and still looked like it was prompting, so "answering resolves both"
is unmet on the native plane.

**A4b PASS** — first allow-once succeeded, resolved, and acted once; the second
answer was a typed `already-answered` refusal with no second execution.

That is the first-allow / second-refuse measurement this issue asked for.

### Run 3 — not scored

Reading: `readings/a4-codex-user-90s-timeout.txt`

A 90s native-ask window was tried once. The Chat websocket timed out at
~5m17s with an uncaught TimeoutError. Reverted. The 30s window from run 2
stands.

## Probe change

`docs/evidence/pod-2777/a4.ts` now:

1. Creates a unique dummy Git repository under `$HOME` outside every trusted
   project root and `/tmp`, and uses it as the Codex `sessions.create` cwd.
2. For Codex only, sets isolated `approvals_reviewer=user` for the probe and
   restores the previous bytes on every exit.

Existing controls are unchanged: positive turn, structured-ask enumeration,
delayed native attach, allow-once first answer, exact one-action check, typed
second-answer refusal.

## Not done

- `docs/plans/pod-1761-results.tsv` was not edited.
- No `test:heavy` suite. The lean gate was not run: this is a docs/evidence
  probe, no `apps/` `packages/` or `scripts/` change.
- No provider credentials created or rotated. Isolated home received a copy of
  the existing Codex `auth.json` the way this rig already does.
- No sandbox services. No main-branch landing.
