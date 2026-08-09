import { join } from 'node:path'
import {
  runWithValidationAdmission,
  shouldAcquireValidationLease,
  type ValidationProcessOptions,
} from './validation-admission'

export type TestProcessOptions = ValidationProcessOptions

/** Only live Podium sessions have an identity that can hold the shared lease. */
export function shouldAcquireHeavyTestLease(env: Record<string, string | undefined>): boolean {
  return shouldAcquireValidationLease(env)
}

/** Serialize resource-heavy test commands when invoked from a live session. */
export async function runWithHeavyTestLease(
  command: string[],
  options: TestProcessOptions,
): Promise<number> {
  return runWithValidationAdmission('heavy', command, {
    ...options,
    label: options.label ?? 'heavy tests',
  })
}

async function main() {
  const args = process.argv.slice(2)
  const separator = args.indexOf('--')
  const command = separator >= 0 ? args.slice(separator + 1) : args
  if (command.length === 0) {
    console.error('usage: bun scripts/test-heavy.ts -- <command> [args...]')
    process.exit(2)
  }

  const root = join(import.meta.dir, '..')
  process.exit(await runWithHeavyTestLease(command, { cwd: root, env: process.env }))
}

if (import.meta.main) await main()
