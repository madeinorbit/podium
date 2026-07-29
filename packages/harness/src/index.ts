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
export * from './cursor/cli.js'
export * from './cursor/paths.js'
export * from './discovery/index.js'
export * from './instructions.js'
export * from './inventory/build-inventory.js'
export * from './issue-system-pointer.js'
export * from './jsonl-stream.js'
export * from './launch.js'
export * from './manifest.js'
export * from './opencode/cli.js'
export * from './opencode/db.js'
export * from './registry.js'
export * from './transcript-source.js'
