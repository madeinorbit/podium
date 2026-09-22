/**
 * @podium/harness — the home for coding-agent CLI variance.
 *
 * ONE manifest object per CLI (`AgentManifest`) carrying everything Podium needs
 * to drive it: launch, one-shot exec, headless turns, native-state observation,
 * conversation discovery and transcript reads. The registry
 * (`Record<BuiltinHarnessKind, AgentManifest>`) is the ONLY dispatch — the
 * daemon is a generic host over this interface and never branches on which CLI
 * it is talking to.
 *
 * This package is a PRINCIPAL-FREE library. It carries no operator, no user id
 * and no capability or grant check: a manifest answers "what is this software
 * and what can it do", never "who is allowed to use it". Authorization lives at
 * the server projection boundary (POD-1079); the daemon runs discovery as a
 * system principal which may read across owners but never acts as a person
 * (docs/multi-user-readiness.md §3.1.6 S5).
 */

export * from './agent-state/index.js'
// Per-harness state sections (POD-4520, spec §4.5): the providers, causal
// observers, locate/binding helpers and fingerprints live in adapters/<h>/
// and are re-exported here so daemon hosts keep one import surface —
// `agent-state/` itself holds only harness-free vocabulary (see its barrel).
export * from './adapters/claude-code/state-provider.js'
export * from './adapters/claude-code/state-locate.js'
export * from './adapters/codex/state-provider.js'
export * from './adapters/cursor/state.js'
export * from './adapters/grok/state-provider.js'
export * from './adapters/grok/state-binding.js'
export * from './adapters/grok/state-causal.js'
export * from './adapters/grok/state-locate.js'
export * from './adapters/opencode/state.js'
export * from './adapters/pi/state.js'
export type { AgentManifest as HarnessAdapter } from './adapter.js'
export * from './descriptors.js'
export type {
  HarnessBrandTone,
  HarnessCatalogData,
  HarnessClientCapabilities,
  HarnessDescriptorData,
  HarnessIconData,
  HarnessLoginCopy,
  StaticModelEntry,
} from './descriptor-types.js'
export * from './codex-auth-identity.js'
export * from './codex-credential-absence-grace.js'
export * from './credential-freshness.js'
export * from './cursor/cli.js'
export * from './cursor/paths.js'
export * from './discovery/index.js'
export * from './executable-runtime.js'
export * from './instructions.js'
export * from './inventory/build-inventory.js'
export * from './issue-system-pointer.js'
export * from './jsonl-stream.js'
export * from './launch.js'
export * from './manifest.js'
export {
  claudeHookAcceptCorrelation,
  transcriptEchoAcceptCorrelation,
} from './accept-correlation.js'
export { codexMcpArgs, codexTranscriptPlacement } from './adapters/codex/index.js'
// Host-only sqlite source surface (POD-4520): the opencode cursor stamper the
// daemon supplies to the opencode observer as an injected port, so the adapter
// names nothing under store/ (spec §5). Behind this barrel, never the store
// entry — see store.ts.
export { stampOpencodeItems } from './store/sources/sqlite.js'
export * from './model-probe.js'
export { opencodeAuthPath } from './opencode/auth.js'
export * from './opencode/cli.js'
export * from './opencode/db.js'
export * from './pi/paths.js'
export * from './registry.js'
export * from './version-policy.js'
export * from './version-probe.js'
