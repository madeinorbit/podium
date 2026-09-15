/**
 * @podium/process/durable — the durable hosts (P2a door).
 *
 * What makes a session survive the daemon: the abduco adapter with its vendored-C
 * build pipeline, the podium-host adapter with its own build pipeline, and the
 * systemd scope argv that places a master outside the daemon's cgroup. Importing
 * this subpath means driving a real durable process — it is the auditable door
 * P2b narrows to `DurableProcess`. `createAltScreenStripper` lives here in source
 * but is exported from `./screen`: a title/alt-screen is output interpretation,
 * and P2c moves it there.
 */

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
  type HostAgentSession,
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
