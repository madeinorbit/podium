/**
 * `@podium/harness/inventory` — THE MACHINE INVENTORY ENTRY (POD-4469, daemon only).
 *
 * What is installed on THIS machine, at which version, under which executable:
 * the probe-exec port plus the inventory builders the daemon runs with real
 * `child_process` effects. Host-only by construction — clients never probe a
 * machine, they read the served `inventoryReport` — so this entry stays OUT of
 * the open surface: only the machine host (`apps/daemon`) and the build tier
 * may import it, per the package's consumer restriction. Later phases grow
 * this directory with login, credentials, usage and install (spec §4.5); the
 * entry stays the same shape, widened by name.
 */

export type {
  BuildInventoryOptions,
  BuildMachineInventoryOptions,
  LoginProbeExec,
  MachineHarnessInventory,
  ManagedHarnessRecord,
  ManagedInstallsRead,
  ManagedInstallsReader,
  ManagedReleaseCandidate,
  ProbeExec,
  ResolvedHarnessExecutable,
  ResolvedHarnessInventory,
} from './inventory/build-inventory.js'
export {
  buildInventory,
  buildMachineInventory,
  buildResolvedInventory,
} from './inventory/build-inventory.js'
export { FileCredentialStore, MAX_CREDENTIAL_BYTES } from './inventory/credential-store.js'
export type {
  CredentialExportMessage,
  CredentialHandlerPorts,
  CredentialInstallMessage,
  CredentialRuntimeSnapshot,
  PortableCredentialOptions,
} from './inventory/credentials.js'
export {
  CredentialAccountUnavailableError,
  handleCredentialExport,
  handleCredentialInstall,
  installPortableCredential,
  readPortableCredential,
} from './inventory/credentials.js'
export type { InstallRequestPorts, InstallTarget } from './inventory/install.js'
export { installableTargets, installTargetFor, runInstallTarget } from './inventory/install.js'
export type {
  AcquireInstallLockOptions,
  AcquireInstallLockResult,
  HomeEditRecord,
  InstallLedgerOptions,
  InstallLock,
  InstallLockHolder,
  LedgerRebuild,
  ManagedInstall,
  RejectedRelease,
  SessionInstall,
  StoredHomeEdit,
} from './inventory/install-ledger.js'
export {
  DEFAULT_INSTALL_LEASE_MS,
  defaultHarnessesDir,
  defaultInstallLedgerPath,
  INSTALL_LEDGER_SCHEMA_VERSION,
  InstallLedger,
  InstallLedgerTooNewError,
  InstallLockLostError,
  LEDGER_FILE,
} from './inventory/install-ledger.js'
export type { ReadReceiptResult, ReleaseFolder } from './inventory/install-receipt.js'
export {
  InstallReceipt,
  listReleaseFolders,
  parseReleaseFolderName,
  RECEIPT_FILE,
  RECEIPT_FORMAT,
  ReleaseIntegrity,
  readInstallReceipt,
  releaseFolderName,
  writeInstallReceipt,
} from './inventory/install-receipt.js'
export type {
  HousekeepOptions,
  HousekeepResult,
  InstallReleaseOptions,
  InstallReleaseResult,
  InstallStep,
  ManagedInstallHostOptions,
  ManagedInstallTarget,
  VendorOrigins,
  VersionProbeResult,
} from './inventory/managed-install.js'
export {
  applyVendorOrigins,
  housekeepReleases,
  installerEnvFor,
  installRelease,
  managedCheckPorts,
  managedInstallEnv,
  managedInstallPorts,
  managedInstallTargetFor,
  managedInstallTargets,
  printsVersion,
  probeExecutable,
  sweepReleaseFolders,
  VENDOR_ORIGINS_ENV,
  vendorOriginsFromEnv,
} from './inventory/managed-install.js'
export { managedInstallsReader, readManagedInstalls } from './inventory/managed-installs.js'
export type { AccountReadScope, QuotaFetcher } from './inventory/usage.js'
export {
  makeQuotaFetcher,
  quotaAgentLabel,
  scanHostUsage,
  scanHostUsageSources,
  scanQuotaHistory,
} from './inventory/usage.js'
export type { UsageFileScan, UsageRecord } from './usage-records.js'
export { mergeBuckets, UsageScanCache } from './usage-records.js'
