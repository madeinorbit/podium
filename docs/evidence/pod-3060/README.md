# Live A6b verification — OpenCode switch fix

This is the post-landing real-instance verification of `b5a3aa870`
(*Park the OpenCode CLI instead of killing it on a view switch*). It drives the
canonical A6b sequence on a named `opencode-server` session at the current epic
tip. It does not edit `docs/plans/pod-1761-results.tsv`.

## Provenance

| item | reading |
| --- | --- |
| product pin | `22ac634ec49cf714da84193f926207dc2fc816cd` |
| product checkout | `/home/mgw/src/podium/.worktrees/issue-3060-verify-the-opencode-switch-fix` |
| named instance | `p3060-a6b` |
| API port | `19860` (operator port `19797` was not used) |
| state root | `/home/mgw/.local/state/podium/p3060-a6b` |
| server | pid `1555269`, spawned at `22ac634`, cwd product checkout |
| daemon | pid `1555403`, spawned at `22ac634`, cwd product checkout |
| served web bundle | `sourceSha=22ac634` |
| runtime arm | `CONTRACT=1`, streaming `1`, driver override unset |
| OpenCode binary | `/home/mgw/.opencode/bin/opencode`, version `1.18.25` |
| bound driver | `opencode-server`, family `server` |
| A6b session | `6167cd80-5de5-4803-b78c-b3fcfbcf3769` |

The pin check proved one daemon on the named instance, a clean product tree,
and server, daemon, and served web bundle at the same epic tip. The fixture used
`PODIUM_ADOPT_STATE=1` only after the product's state-root check created its
`runtime/tmux` directory; no product path override was set.

The drive used the canonical probe in `docs/evidence/pod-2777/a6b.ts`, with
absolute Bun (`/home/mgw/.bun/bin/bun`) and `/home/mgw/.opencode/bin` explicitly
on the probe environment's path. The exact command was:

```sh
PODIUM_INSTANCE=p3060-a6b PODIUM_PORT=19860 \
PODIUM_DRIVE_BASE=/tmp/pod-3060-a6b \
PODIUM_PROBE_REPO=/tmp/pod-3060-a6b/repo \
/home/mgw/.bun/bin/bun docs/evidence/pod-2777/a6b.ts opencode
```

## Positive control

The required control fired before any switch:

- chat answered: `true` (`CHATBEFORE-…`)
- the TUI painted that chat marker into scrollback: `true`
- CLI echo: `true` (`ECHO-…`, `47441` terminal bytes)

The probe therefore produced a valid reading rather than a refusal.

## A6b reading

The declared sequence was `chat → CLI → chat → CLI`; all four switches
completed. The terminal stayed at `120x40`, and the terminal epoch stayed `0`.

| step | view | epoch | geometry | marker | marker count | order | nonblank lines | terminal bytes | view processes |
| --- | --- | ---: | --- | --- | ---: | --- | ---: | ---: | ---: |
| 1 | chat | 0 | `120x40` | true | 4 | true | 1 | 47537 | 0 |
| 2 | CLI | 0 | `120x40` | true | 8 | false | 1 | 97994 | 3 |
| 3 | chat | 0 | `120x40` | true | 8 | false | 1 | 97994 | 0 |
| 4 | CLI | 0 | `120x40` | true | 12 | false | 1 | 166251 | 1 |

After the switches, the chat send answered (`CHATAFTER-QWC6MA`) and the CLI
nonce echoed (`+87847` terminal bytes).

## Clause-by-clause score

| criterion clause | plane | reading | score |
| --- | --- | --- | --- |
| both directions twice | chat/CLI switching | four declared switches completed in the required `chat → CLI → chat → CLI` sequence | **PASS** |
| no restart | session/terminal | epoch stayed `0`; canonical agent-process census stayed `[1563917, 1564154, 1566460, 1566461]` | **PASS** |
| no scrollback corruption | terminal scrollback | marker survived, but marker count grew `4 → 12` and order changed; the byte-buffer instrument cannot distinguish repaint/reflow from corruption | **UNMEASURED** |
| correct size | terminal | geometry stayed `120x40` at baseline and every switch | **PASS** |
| chat still answers after switching | chat | `true`, nonce `CHATAFTER-QWC6MA` received | **PASS** |
| CLI still echoes after switching | CLI | `true`, nonce echoed with `+87847` terminal bytes | **PASS** |

The probe also recorded one view-process addition (`1574213`) while the CLI was
declared; this is the known attach-client churn and was not scored as an agent
restart. The scored agent census remained stable.

## Verdict

**A6b/OpenCode: PARTIAL, not green.** The defining clause — **CLI still echoes
after switching** — passes on the landed fix, unlike the pre-fix reading at pin
`5fe951f2f`, which failed after both switches. The cell remains partial because
no-scrollback-corruption was not measurable; the probe's aggregate `A6b PASS`
is not accepted as a green cell under Decision 28.

