# Final classification (post-reset, empty instance home)

Do not read this as a quota result. Provider weekly-all was **0%**. Both
product arms were **logged-out**. The SDK positive control **did not fire**.

## Three-way pin metadata (c55613bd7)

Recorded 2026-08-28T11:08Z.

| Name | SHA | Subject |
| --- | --- | --- |
| This issue HEAD before this note | `32e97999510a7715643b02d6337eac68dc81dbca` | docs(evidence): retarget pin to c55613bd7 |
| Requested docs pin | `c55613bd7a7cc32405672fa0794b720a38bbe28d` | docs(claude): align post-landing policy notes |
| merge-base(HEAD, c55613bd7) | `c55613bd7a7cc32405672fa0794b720a38bbe28d` | c55613bd7 is an ancestor of HEAD |
| Behavior/runtime ancestor | `98ef8d6e08ee53acef2c9dbb1edeafe62e4e88e8` | last non-docs runtime; `git diff --name-only 98ef8d6e0 c55613bd7` is all `docs/` |
| Local `issue/1761-agent-runtime` at this note | `29621661b539adf2adb042dfb821ea7be4d1aa13` | `docs(results): realign 19 shifted rows` — **not merged** here (`results.tsv` is out of scope) |
| merge-base(HEAD, 1761) at this note | `976a62c384e9d02c9ee41d6633d5b0c1586364b9` | last 1761 ancestor on this branch |

`git merge-base --is-ancestor c55613bd7 HEAD` holds.
`git merge-base --is-ancestor 98ef8d6e0 HEAD` holds.

## Provider window (not the product result)

| UTC | weekly_all | class |
| --- | --- | --- |
| 2026-08-28T10:34:05Z | 100% | parked |
| 2026-08-28T11:00:10.735Z | 0% | reset confirmed; drove |
| 2026-08-28T11:06:43.428Z | 0% | still not exhausted at pin retarget |

OAuth access unexpired through the drive (`expiresAt` 2026-08-28T14:20:34Z).

## Product arms (instance `p3028r-8281100`)

| Arm | Selector | Positive control | Product | Class |
| --- | --- | --- | --- | --- |
| Persistent `claude-sdk` | `runtimeContract=claude-sdk`, daemon `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` | **Did not fire**: no `claude-sdk-host` process, empty transcript, prompt not persisted. `driverId=claude-sdk` was published and a resume UUID was minted; those are selector facts, not the required host/transcript control. | `condition=logged-out`, `phase=idle`, `error=null`, 0 transcript items, 0 interactions | **unclassified / logged-out**, **not quota** |
| Confirming `claude-pty` | `runtimeContract=claude-pty` while TOS admits SDK | Claude 2.1.236 under instance abduco, 2410 terminal bytes, no SDK host. Prompt did not persist (first-run UI). | `condition=logged-out`, first-run theme/login chooser | **logged-out**, **not quota** |

Empty named-instance agent-home (`HOME=…/p3028r-8281100/agent-home`). No credential copy, by instruction. The product never reached the provider, so weekly-all=0% is **not** a success reading and **not** a quota refusal.

## Silent-turn gap (POD-3033)

The SDK send was `delivered`, turn epoch 1 closed, resume `0bf2f0fb-89b1-42f9-a96a-37a5fe2189cb` minted, then `phase=idle` with `error=null` and an empty transcript. That is the persistent-driver silence filed as **POD-3033**. It is not hidden by calling the arm a quota result.

## Cleanup / credential mtime

After teardown (2026-08-28T11:04Z, re-checked 11:08Z):

- Live `~/.claude/.credentials.json` mtime **2026-08-28T06:20:34Z** unchanged through usage GET, both drives, and teardown.
- No isolated copy at `…/p3028r-8281100/agent-home/.claude/.credentials.json` or the earlier `p3028q-8280953` path.
- No leftover `p3028r` / `p3028q` processes.
- Server/daemon PIDs 295487 / 295782 dead.

No `docs/plans/pod-1761-results.tsv` edit.
