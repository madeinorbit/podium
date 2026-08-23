/** Render the last three-unit packaged topology for the Docker migration fixture. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderDaemonUnit,
  renderJanitorUnit,
  renderServerUnit,
} from '../../apps/cli/src/cli-systemd'

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
  [`podium-${instanceId}-janitor.service`]: renderJanitorUnit({ instanceId, port }),
}

for (const [name, body] of Object.entries(units)) {
  writeFileSync(join(outputDir, name), body)
}
