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
  ProbeExec,
  ResolvedHarnessExecutable,
  ResolvedHarnessInventory,
} from './inventory/build-inventory.js'
export {
  buildInventory,
  buildMachineInventory,
  buildResolvedInventory,
} from './inventory/build-inventory.js'
export type {
  CredentialExportMessage,
  CredentialHandlerPorts,
  CredentialInstallMessage,
  CredentialRuntimeSnapshot,
  PortableCredentialOptions,
} from './inventory/credentials.js'
export {
  handleCredentialExport,
  handleCredentialInstall,
  installPortableCredential,
  readPortableCredential,
} from './inventory/credentials.js'
export { FileCredentialStore, MAX_CREDENTIAL_BYTES } from './inventory/credential-store.js'
export type { InstallRequestPorts, InstallTarget } from './inventory/install.js'
export { installableTargets, installTargetFor, runInstallTarget } from './inventory/install.js'
export type { QuotaFetcher } from './inventory/usage.js'
export {
  makeQuotaFetcher,
  quotaAgentLabel,
  scanHostUsage,
  scanHostUsageSources,
  scanQuotaHistory,
} from './inventory/usage.js'
export { UsageScanCache } from './usage-records.js'
export type { UsageFileScan, UsageRecord } from './usage-records.js'
