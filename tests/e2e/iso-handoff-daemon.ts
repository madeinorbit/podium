/**
 * Isolated handoff-E2E daemon for the TARGET machine (vmi, issue #498).
 * Connects to the iso host's server over the tailnet with a pre-provisioned
 * machine token (the host upserts the machine row at boot). Fully isolated
 * from the live vmi daemon: own state dir (set PODIUM_STATE_DIR), ephemeral
 * hook/agent-relay ports, no systemd scopes.
 *
 * Run on the target from the synced source tree:
 *   PODIUM_STATE_DIR=/tmp/podium-iso-498 PODIUM_NO_SCOPE=1 \
 *   ISO_SERVER=ws://ludovico.shetland-banjo.ts.net:18788 \
 *   bun --conditions=@podium/source tests/e2e/iso-handoff-daemon.ts
 */
import { startDaemon } from '../../apps/daemon/src/daemon'

const serverUrl = process.env.ISO_SERVER
if (!serverUrl) throw new Error('ISO_SERVER required (ws://host:port)')

const daemon = await startDaemon({
  serverUrl,
  bootstrapToken: process.env.ISO_TOKEN ?? 'iso-handoff-498-vmi-token',
  machineId: process.env.ISO_MACHINE_ID ?? 'vmi-e2e',
  hooks: { port: 0 },
  agentRelay: { port: 0 },
})

console.log('[iso-daemon] connected to', serverUrl)
process.on('SIGINT', () => void daemon.close({ reapSessions: true }).then(() => process.exit(0)))
process.on('SIGTERM', () => void daemon.close({ reapSessions: true }).then(() => process.exit(0)))
await new Promise(() => {})
