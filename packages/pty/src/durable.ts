/**
 * @podium/process/durable — the durable hosts (P2a door).
 *
 * What makes a session survive the daemon: the abduco adapter with its vendored-C
 * build pipeline, the podium-host adapter with its own build pipeline, and the
 * systemd scope argv that places a master outside the daemon's cgroup. Importing
 * this subpath means driving a real durable process — it is the auditable door
 * P2b narrows to `DurableProcess`. `createAltScreenStripper` lives in
 * `./alt-screen-stripper.js` and is exported from `./screen`: a title/alt-screen
 * is output interpretation, and P2c moved it there (`abduco.ts` keeps a
 * re-export so no importer changes).
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
  type Durable as DurableLegacy,
  abducoDurableAdapter,
  hostDurableAdapter,
  createDurableProcess,
  createDurable,
  sweepStaleDurableBindTemps,
  durableProcessFor,
  durableFor,
} from './durable-process.js'
// The attachment handle both adapters implement, re-exported so the durable
// door names the ONE interface (POD-4434). Type-only: it widens no runtime
// capability, and the P2b value door above is unchanged.
export type { DurableAttachment } from './session.js'

export {
  abducoAttachArgv,
  resolveAttachBin,
  abducoCreateArgv,
  systemdScopeArgv,
  scopeUnitName,
  scopeReclaimArgvs,
  type SystemctlRunner,
  reclaimStaleScope,
  reclaimTerminatedSession,
  userRuntimeDir,
  scopeEnv,
  canScopeMaster,
  applySessionsSliceBudget,
  isAbducoAvailable,
  type AbducoSessionEntry,
  parseAbducoList,
  liveEnv,
  abducoSocketPath,
  reapStaleAbducoBindTemps,
  abducoTerminatedSocketPaths,
  waitForAbducoSocket,
  abducoSocketHasSession,
  abducoHasSession,
  killAbducoSession,
  listLiveAbducoLabels,
  stopSessionScope,
  reapAbducoTestSessions,
  type AbducoSpawnOptions,
  execCreate,
  withComposedSocketPath,
  spawnAbducoAgent,
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
  type HostManifest,
  hostSupported,
  defaultHostCachePath,
  managedHostDir,
  hostBinFeatures,
  vendoredHostSourceHash,
  buildVendoredHost,
  ensureManagedHost,
  resolveHostBin,
  isHostAvailable,
} from './host-bin.js'
