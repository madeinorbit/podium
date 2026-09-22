/**
 * Re-exported from @podium/runtime (POD-4534): `podium setup` runs before any
 * server exists on the box, so the probe it runs cannot go through this
 * package's router — the client had to move somewhere the CLI may import.
 * The wire protocol is untouched; this module is the same client, new home.
 */
export { connectClient } from '@podium/runtime/connect-client'
export type {
  CheckError,
  CheckResult,
  ConnectClient,
  ConnectClientDeps,
  ConnectFailure,
  ConnectOutcome,
  LocatorEndpoint,
  LocatorRecord,
} from '@podium/runtime/connect-client'
