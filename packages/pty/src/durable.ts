/**
 * @podium/process/durable — the durable host (P2a door).
 *
 * What makes a session survive the daemon: the podium-host adapter, the Rust
 * host's resolution (`./host-bin.js`), and the systemd scope argv that places a
 * host outside the daemon's cgroup (`./scope.js`). Nothing spawns on abduco or
 * the C host any more (POD-4986); a running C host is adopted through the host
 * protocol, and a running abduco session through the adoption-only abduco
 * adapter (`./abduco.js`, attach and census only). Importing this subpath means driving a real durable
 * process — it is the auditable door P2b narrows to `DurableProcess`.
 *
 * SOLE ENTRY (P2b): production daemon code reaches a process ONLY through
 * `DurableProcess` (`createDurableProcess` / `durableProcessFor`). The raw
 * per-host functions below remain exported for tests and for the adapters
 * themselves; `apps/daemon/src/durable-door.test.ts` forbids non-test daemon
 * files from importing them.
 */

export {
  type AbducoAttachOptions,
  abducoHasSession,
  abducoSocketHasSession,
  abducoSocketPath,
  attachAbducoAgent,
  killAbducoSession,
  listLiveAbducoLabels,
  reapAbducoTestSessions,
  reapStaleAbducoBindTemps,
  waitForAbducoSocket,
} from './abduco.js'
// TESTS ONLY (POD-4617): the direct-pty stand-in for a durable process. A
// daemon with no durable process refuses every spawn; this is the one place a
// raw pty spawn is still reachable, and the durable-door allow-list keeps it
// out of production daemon code.
export { directPtyDurableForTests } from './direct-pty-durable.js'
// Sole entry — the only way production code spawns, locates, kills or lists.
export {
  abducoAdoptionAdapter,
  createDurableProcess,
  type DurableAdapter,
  type DurableAdapterKind,
  type DurableAttachOptions,
  type DurableBackend,
  type DurableKind,
  type DurableProcess,
  type DurableReattach,
  durableProcessFor,
  type HeadlessAttachOptions,
  type HeadlessSpawnOptions,
  hostDurableAdapter,
  sweepStaleDurableBindTemps,
} from './durable-process.js'
export {
  attachHostAgent,
  checkedPipe,
  connectHost,
  createHostFrameDecoder,
  encodeHello,
  encodeHostFrame,
  HOST_PROTO_VERSION,
  HOST_TAIL,
  type HostAttachOptions,
  HostConnection,
  type HostCreateCommand,
  type HostDurableAttachment,
  HostErr,
  HostError,
  HostFrame,
  type HostResized,
  type HostRetention,
  type HostStatus,
  type HostWelcome,
  hostCreateArgs,
  hostHasSession,
  hostSocketDir,
  hostSocketPath,
  killHostSession,
  listLiveHostLabels,
  liveHostSocket,
  PipeSecretRefusedError,
  probeHostSocket,
  spawnHostAgent,
  WriterLeaseRefusedError,
  waitForHostSocket,
} from './host.js'
export {
  bundledRustHostPath,
  ensureSourceRustHost,
  HOST_FEATURES,
  HOST_UNAVAILABLE,
  hostBinFeatures,
  hostSupported,
  isHostAvailable,
  RUST_HOST_BINARY,
  resolveHostBin,
  sourceRustHostCacheDir,
  vendoredRustHostSourceHash,
} from './host-bin.js'
export {
  applySessionsSliceBudget,
  canScopeMaster,
  type DurableSpawnOptions,
  liveEnv,
  type PipeSecret,
  type SystemctlRunner,
  scopeEnv,
  scopeReclaimArgvs,
  scopeUnitName,
  stopSessionScope,
  systemdScopeArgv,
  userRuntimeDir,
} from './scope.js'
// The attachment handle both adapters implement, re-exported so the durable
// door names the ONE interface (POD-4434). Type-only: it widens no runtime
// capability, and the P2b value door above is unchanged.
export type { DurableAttachment } from './session.js'
