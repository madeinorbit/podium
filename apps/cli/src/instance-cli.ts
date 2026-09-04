/** Operator recovery for copied Podium state roots. */

import { resolveInstanceId, stateDir } from '@podium/runtime/config'
import {
  ensureInstanceStateIdentity,
  rekeyInstanceStateIdentity,
} from '@podium/runtime/instance'
import { acquireStateRootLock } from '@podium/runtime/instance-guard'

export interface InstanceCliIo {
  print(message: string): void
  error(message: string): void
}

const defaultIo: InstanceCliIo = {
  print: (message) => console.log(message),
  error: (message) => console.error(message),
}

export function instanceHelpText(): string {
  return [
    'podium instance <command>',
    '',
    'Manage the local instance owner identity.',
    '',
    'Commands:',
    '  rekey                 Mint a fresh UUID for a copied state root.',
    '  --help                Show this help.',
    '',
    'Rekey refuses while a daemon owns the state root. Existing branches,',
    'transcripts and session rows are preserved; old processes become foreign.',
  ].join('\n')
}

/** Return a CLI exit code so the parser remains straightforward to test. */
export function instanceCliMain(argv: string[], io: InstanceCliIo = defaultIo): number {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.print(instanceHelpText())
    return 0
  }
  if (argv[0] !== 'rekey' || argv.length !== 1) {
    io.error('usage: podium instance rekey')
    return 2
  }

  const dir = stateDir()
  let before
  try {
    before = ensureInstanceStateIdentity({ instanceId: resolveInstanceId(), dir })
  } catch (error) {
    io.error(`podium instance rekey: ${(error as Error).message}`)
    return 1
  }

  let guard
  try {
    guard = acquireStateRootLock({ stateDir: dir, instanceUuid: before.instanceUuid })
  } catch (error) {
    io.error(`podium instance rekey: ${(error as Error).message}`)
    return 1
  }
  try {
    const after = rekeyInstanceStateIdentity(dir)
    io.print(
      `podium instance rekey: ${before.instanceId} ${before.instanceUuid} -> ${after.instanceUuid}`,
    )
    return 0
  } catch (error) {
    io.error(`podium instance rekey: ${(error as Error).message}`)
    return 1
  } finally {
    guard.release()
  }
}
