import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** mise selects the runtime; this catches direct invocations that bypass it. */
export function assertBunToolchain(root = ROOT, actual = Bun.version): void {
  const config = Bun.TOML.parse(readFileSync(join(root, 'mise.toml'), 'utf8')) as {
    tools?: { bun?: unknown }
  }
  const expected = config.tools?.bun
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected)) throw new Error('mise.toml must pin an exact Bun version in [tools].')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (pkg.packageManager !== `bun@${expected}`) {
    throw new Error(`package.json packageManager must match mise.toml: bun@${expected}`)
  }
  if (actual !== expected) {
    throw new Error(
      `Bun ${actual} is running; this checkout requires ${expected} from mise.toml. ` +
        'Run mise install bun and enable mise activation/shims, then retry. ' +
        'Use mise which bun to inspect selection. See docs/toolchain.md.',
    )
  }
}

if (import.meta.main) assertBunToolchain()
