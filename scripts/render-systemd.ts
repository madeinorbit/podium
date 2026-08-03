/**
 * Render systemd files from the source-of-truth functions in cli-systemd.ts.
 *
 * Dev profile (the default) writes the source-based dev-host units under scripts/systemd and
 * refreshes the generated health probe beside them. Packaged profile writes the units that belong
 * in a headless release bundle; scripts/build-bun.ts uses the same API for the actual artifact.
 * Named instances use the same renderer and get instance-scoped unit names and environment.
 *
 * This is a writer, not a checker: drift is caught by scripts/systemd-diff.ts, which renders a
 * fresh dev profile and compares it with the generated files on disk. In particular, this file
 * never extracts unit text from install.sh.
 */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type SystemdProfile,
  type SystemdRenderOptions,
  writeSystemdFiles,
} from '../apps/cli/src/cli-systemd'

const root = fileURLToPath(new URL('..', import.meta.url))

function value(flag: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const profile = (value('--profile') ?? 'dev') as SystemdProfile
if (profile !== 'dev' && profile !== 'packaged') {
  throw new Error(`render-systemd: unknown profile '${profile}' (expected dev or packaged)`)
}
const instanceId = value('--instance')
const output = resolve(
  value('--output') ??
    (profile === 'dev' ? join(root, 'scripts/systemd') : join(root, 'dist-bun/headless/systemd')),
)
const opts: SystemdRenderOptions = { profile, ...(instanceId ? { instanceId } : {}) }
const healthPath =
  profile === 'dev'
    ? join(root, 'scripts/podium-health-probe.sh')
    : join(output, 'podium-health-probe.sh')
writeSystemdFiles(output, opts, healthPath)
console.log(`render-systemd: wrote ${profile} profile (${instanceId ?? 'default'}) to ${output}`)
