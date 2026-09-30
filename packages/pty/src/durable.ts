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

// Sole entry — the only way production code spawns, locates, kills or lists.
export {
  type DurableBackend,
  type DurableKind,
  type DurableAttachOptions,
  type DurableReattach,
  type DurableAdapter,
  type DurableProcess,
  type HeadlessSpawnOptions,
  type HeadlessAttachOptions,
  type DurableAdapterKind,
  hostDurableAdapter,
  abducoAdoptionAdapter,
  createDurableProcess,
  sweepStaleDurableBindTemps,
  durableProcessFor,
} from './durable-process.js'
// TESTS ONLY (POD-4617): the direct-pty stand-in for a durable process. A
// daemon with no durable process refuses every spawn; this is the one place a
// raw pty spawn is still reachable, and the durable-door allow-list keeps it
// out of production daemon code.
export { directPtyDurableForTests } from './direct-pty-durable.js'
// The attachment handle both adapters implement, re-exported so the durable
// door names the ONE interface (POD-4434). Type-only: it widens no runtime
// capability, and the P2b value door above is unchanged.
export type { DurableAttachment } from './session.js'

export {
  systemdScopeArgv,
  scopeUnitName,
  scopeReclaimArgvs,
  type SystemctlRunner,
  userRuntimeDir,
  scopeEnv,
  canScopeMaster,
  applySessionsSliceBudget,
  liveEnv,
  stopSessionScope,
  type DurableSpawnOptions,
} from './scope.js'
export {
  abducoAttachArgv,
  resolveAttachBin,
  isAbducoAvailable,
  type AbducoSessionEntry,
  parseAbducoList,
  abducoSocketPath,
  reapStaleAbducoBindTemps,
  abducoTerminatedSocketPaths,
  waitForAbducoSocket,
  abducoSocketHasSession,
  abducoHasSession,
  killAbducoSession,
  listLiveAbducoLabels,
  reapAbducoTestSessions,
  type AbducoAttachOptions,
  attachAbducoAgent,
} from './abduco.js'
export {
  ABDUCO_FEATURES,
  type AbducoManifest,
  abducoSupported,
  defaultAbducoCachePath,
  managedAbducoDir,
  abducoBinFeatures,
  vendoredAbducoSourceHash,
  buildVendoredAbduco,
  ensureManagedAbduco,
  resolveAbducoBin,
} from './abduco-bin.js'
export {
  HOST_PROTO_VERSION,
  HostFrame,
  HostErr,
  HOST_TAIL,
  hostCreateArgs,
  type HostCreateCommand,
  type HostRetention,
  encodeHostFrame,
  encodeHello,
  createHostFrameDecoder,
  type HostWelcome,
  type HostStatus,
  type HostResized,
  HostError,
  HostConnection,
  connectHost,
  hostSocketDir,
  hostSocketPath,
  probeHostSocket,
  waitForHostSocket,
  liveHostSocket,
  hostHasSession,
  listLiveHostLabels,
  killHostSession,
  type HostAttachOptions,
  type HostDurableAttachment,
  WriterLeaseRefusedError,
  attachHostAgent,
  spawnHostAgent,
} from './host.js'
export {
  HOST_FEATURES,
  HOST_UNAVAILABLE,
  RUST_HOST_BINARY,
  bundledRustHostPath,
  hostSupported,
  hostBinFeatures,
  sourceRustHostCacheDir,
  vendoredRustHostSourceHash,
  ensureSourceRustHost,
  resolveHostBin,
  isHostAvailable,
} from './host-bin.js'
