# Provider state-channel ledger

This ledger records the state channels declared by each harness manifest for this issue. Order is preference order. A channel describes daemon observation provenance only: it never supplies a user, owner, actor, account, or authorization principal.

| Provider | Preferred channel | Fallback | Native turn boundary | Current limitation and upgrade path |
|---|---|---|---|---|
| Claude Code | Structured lifecycle hooks (confidence 1.0) | Manifest-private Claude transcript rules through the harness-neutral classifier engine (0.3) | `Stop` | Keep hooks primary. Replace individual classifier verdicts with new structured hook verdict fields when Claude exposes them; keep the generic engine available only for explicit manifest opt-ins. |
| Codex | Structured lifecycle hooks (1.0) | Rollout JSONL polling/tailing (0.7), reconciled inside the Codex manifest | Hook `Stop`; rollout `task_complete` / `turn_aborted` | The rollout remains the durable fallback and binding source. Adopt broader native hook coverage as Codex ships it; dual-channel reconciliation must remain manifest-owned. |
| Grok | `updates.jsonl` polling/tailing (0.7) | None declared | `session/update` → `turn_completed` (observed behavior recorded by `980bd21f`) | Adopt a supported structured lifecycle-hook API when Grok ships one, place it before poll, and retain poll as the lower-confidence fallback. |
| OpenCode | SQLite session/message polling (0.7) | None declared | `step-finish` message part | Adopt native lifecycle hooks when available; keep SQLite polling as the fallback until hook coverage includes needs-human and turn completion. |
| Cursor | Per-chat transcript polling/tailing (0.7) | None declared | `turn_ended` transcript record | Adopt native lifecycle hooks when available; keep transcript polling as the fallback until hook coverage includes needs-human and turn completion. |

## Reconciliation contract

Every event crossing a manifest/provider boundary carries `source` and numeric `confidence`. Within the five-second staleness window, the shared reducer retains the higher-confidence observation: hook beats poll, and poll beats classifier. After the window, a fresh lower-confidence observation may advance a quiet session instead of leaving it permanently pinned to old evidence.

Codex is the only current dual native/poll channel and reconciles those inputs inside its manifest before the generic host consumes them. Claude is the only manifest that opts into transcript classification. The engine in `packages/harness/src/agent-state/transcript-classifier.ts` has no provider vocabulary; Claude’s feature extraction and keyword/regex rules remain private beside its manifest.

## Attribution, routing, and privacy

State is a system observation scoped by the precise Podium session ID. Provider payload identities and transcript text cannot become attribution; ownership is resolved later from the authenticated session record. Needs-attention delivery therefore targets the owning principal’s clients and fails closed when ownership is unresolved—there is no global operator or broadcast fallback.

Classifier output is limited to the normalized state verdict and channel provenance. Rule matches, excerpts, prompts, and quoted transcript content are not placed on cross-session surfaces or in state events.

Browser-open intent classification is deliberately absent from this table. It is a control affordance owned by the separate capability manifest work, not an observation channel.
