/**
 * Render the last three-unit packaged topology for the Docker migration fixture.
 *
 * The server and daemon units still come from the live renderers, because those
 * roles still exist. The JANITOR unit is a frozen copy of the last body Podium
 * ever wrote (PDM-27 deleted `renderJanitorUnit` along with the standalone
 * process): this fixture must keep producing the unit a real legacy install
 * has on disk, and nothing else may render one again.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderDaemonUnit, renderServerUnit } from '../../apps/cli/src/cli-systemd'

/** The retired janitor unit, exactly as installs before PDM-27 carry it. */
function legacyJanitorUnit(instanceId: string, port: number): string {
  const command = instanceId === 'default' ? 'podium' : `podium-${instanceId}`
  const serverUnit =
    instanceId === 'default' ? 'podium-server.service' : `podium-${instanceId}-server.service`
  return `# GENERATED from apps/cli/src/cli-systemd.ts by scripts/render-systemd.ts.
# Do not hand-edit; rerun the renderer after changing the source.
[Unit]
Description=Podium durable maintenance janitor
After=network-online.target ${serverUnit}
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=${instanceId}
Environment=PODIUM_PORT=${port}
ExecStart=%h/.local/bin/${command} janitor
Restart=always
RestartSec=2
# A protocol/schema mismatch is terminal until the installed bundle catches up.
RestartPreventExitStatus=78
# Housekeeping is deliberately below the interactive server/daemon tier. Each DB
# pass is bounded and yields via the shared time-budget helper.
CPUWeight=100
IOWeight=100

[Install]
WantedBy=default.target
`
}

const [instanceId, outputDir] = process.argv.slice(2)
if (!instanceId || !outputDir) {
  throw new Error('usage: render-legacy-units.ts <instance> <output-dir>')
}

const port = 18_787
mkdirSync(outputDir, { recursive: true })
const units = {
  [`podium-${instanceId}-server.service`]: renderServerUnit({
    profile: 'packaged',
    instanceId,
    port,
  }),
  [`podium-${instanceId}-daemon.service`]: renderDaemonUnit({
    profile: 'packaged',
    instanceId,
    port,
    local: true,
  }),
  [`podium-${instanceId}-janitor.service`]: legacyJanitorUnit(instanceId, port),
}

for (const [name, body] of Object.entries(units)) {
  writeFileSync(join(outputDir, name), body)
}
