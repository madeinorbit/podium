# POD-3065 — no-marker cell re-check

Re-driven on 2026-08-28 at the current epic tip `f76f698cecc8aeb5021803902579a17d7a0852dc`, after `1b5ebc9c1` (the named-instance headless-home repair) and `ccdea1f93`. No row in `docs/plans/pod-1761-results.tsv` was edited.

## Path determination

The three requested harnesses are server drivers, not the patched durable-headless family. `apps/daemon/src/host-runtime.ts` imports `createCodexHost`, `createGrokAcpHost`, and `createOpencodeHost` at lines 76, 84, and 90, then constructs their separate server runtimes at lines 766–789 and 796–838. The server runtime files do not import `durable-headless.ts` or `headless-drivers.ts`; those patched modules are reached by `control/headless.ts` and the Claude SDK runtime. Therefore the named-instance HOME fix does not causally explain these three server-driver results.

## Pin and control bar

- Named instance: `p3065x`; state root: `/home/mgw/.local/state/podium/p3065x`; API: `127.0.0.1:19965`.
- Server, daemon, and served web bundle were each verified at the full SHA above. The persisted verification is in [pin-verification.log](readings/pin-verification.log).
- Harnesses were resolved as codex `/home/mgw/.local/bin/codex` 0.149.1, opencode `/home/mgw/.opencode/bin/opencode` 1.18.25, and grok `/home/mgw/.local/bin/grok` 0.2.118.
- Every scored run fired its positive control. A run without a fired control would not be a verdict.

## Clause scores

### A3 — codex-app-server

Raw evidence: [codex-a3.log](readings/codex-a3.log).

| Clause | Score | Evidence |
| --- | --- | --- |
| Positive control fired | PASS | 3 preview frames while `phase=working`; driver bound as `codex-app-server/server`. |
| Protocol interrupt accepted | PASS | `{"ok":true,"requested":"protocol"}`. |
| Turn stopped | PASS | Phase left `working` after 524 ms; idle/live afterward. |
| No continuing terminal output | PASS | 0 terminal bytes at the call and +0 after 6 s and 12 s. |
| Transcript interrupt marker present | FAIL | No item carried `event:'interrupt'`. |
| Cell verdict | PARTIAL | Same substantive result as the old PARTIAL; no improvement. |

### A3 — opencode-server

Raw evidence: [opencode-a3.log](readings/opencode-a3.log).

| Clause | Score | Evidence |
| --- | --- | --- |
| Positive control fired | PASS | 5 preview frames while `phase=working`; driver bound as `opencode-server/server`. |
| Protocol interrupt accepted | PASS | `{"ok":true,"requested":"protocol"}`. |
| Turn stopped | PASS | Phase left `working` after 14 ms; idle/live afterward. |
| No continuing terminal output | PASS | 0 terminal bytes at the call and +0 after 6 s and 12 s. |
| Transcript interrupt marker present | FAIL | No item carried `event:'interrupt'`. |
| Cell verdict | PARTIAL | Same substantive result as the old PARTIAL; no improvement. |

### A5 — grok-acp

Raw evidence: [grok-a5.log](readings/grok-a5.log).

| Clause | Score | Evidence |
| --- | --- | --- |
| Positive control fired | PASS | 3 transcript items, 1 tool item, and 3 delta frames; driver bound as `grok-acp/server`. |
| Live tool call was read | PASS | The non-empty transcript contained one tool item with `call=true`. |
| Live provider result paired to the call | FAIL | `result=false`; provider result was `null`; the turn did not complete. |
| Tool history survived reload | PASS | Fresh socket served all 3 live items and retained 1 tool item; exact tool history was true. |
| Paired provider payload survived reload | FAIL | Reload still had provider result `null`, no nonce, and `paired after reload false`; the probe's “same history” clause was false. |
| Cell verdict | FAIL | Same substantive failure as the old `call=true but result missing`; no improvement. |

## Conclusion

The re-check found no improvement in any requested cell. The two A3 cells still stop their live server turns but do not record an interrupt marker. Grok still exposes a tool call without a provider result, and the non-empty reload read confirms this is not the former named-instance empty-reader artifact.

The A3 absence is not attributable to `1b5ebc9c1`: these are server drivers outside that patch. POD-3042’s MAIN/DEFAULT generic-PTY baseline also reported no marker, so this evidence does not support a claim that the epic gained a marker that main lacks; no new main drive was performed here.
