/**
 * `podium vault status` and `podium vault reset --confirm` (POD-6889).
 *
 * The vault holds every secret Podium stores, encrypted under a data key that the
 * key file (outside the state directory) unlocks. `status` says where that file
 * is expected and whether the vault can be opened. `reset` is the way out when the
 * key file is lost for good: it deletes every stored secret, and the credentials
 * they belonged to must be added again. Both are for an admin of this server.
 */

import { localServerUrl, resolvePort } from '@podium/runtime/config'
import { makeOperatorIssueClient } from './operator-client'

export interface VaultStatusReply {
  keyPath: string
  keyId: string | null
  state: 'ready' | 'empty' | 'locked'
  problem: string | null
}

export interface VaultResetReply {
  needsAttention: number
  state: string
}

export interface VaultClient {
  vault: {
    status: { query: () => Promise<VaultStatusReply> }
    reset: { mutate: (input: { confirm: true }) => Promise<VaultResetReply> }
  }
}

export class VaultCliError extends Error {}

export function vaultHelpText(): string {
  return [
    'Usage: podium vault <command>',
    '',
    '  status [--json]          Where the vault key file is expected, and whether it opens',
    '  reset --confirm [--json] Delete every stored secret after the key file was lost for good.',
    '                           Credentials that held one need to be added again.',
    '',
    'The key file is $PODIUM_VAULT_KEY_FILE, else $XDG_CONFIG_HOME/podium/vault-<instance>.key,',
    'else ~/.config/podium/vault-<instance>.key. Back it up separately from the state directory.',
  ].join('\n')
}

const STATE_TEXT: Record<VaultStatusReply['state'], string> = {
  ready: 'ready: stored credentials can be used',
  empty: 'empty: no secret stored yet; the key is created with the first one',
  locked: 'LOCKED: stored credentials cannot be used until the key file is back',
}

export function renderVaultStatus(reply: VaultStatusReply): string {
  return [
    `Vault:    ${STATE_TEXT[reply.state]}`,
    `Key file: ${reply.keyPath}`,
    ...(reply.keyId ? [`Key id:   ${reply.keyId}`] : []),
    ...(reply.problem ? ['', reply.problem] : []),
  ].join('\n')
}

const isHelp = (argv: string[]): boolean =>
  argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help'

export async function runVaultCli(argv: string[], client: VaultClient): Promise<string> {
  const [command, ...rest] = argv
  const known = command === 'reset' ? ['--confirm', '--json'] : ['--json']
  const stray = rest.find((arg) => !known.includes(arg))
  if (stray) throw new VaultCliError(`unknown argument ${stray}`)
  const json = rest.includes('--json')
  if (command === 'status') {
    const reply = await client.vault.status.query()
    return json
      ? JSON.stringify({ command: 'vault status', ok: true, data: reply })
      : renderVaultStatus(reply)
  }
  if (command === 'reset') {
    if (!rest.includes('--confirm')) {
      throw new VaultCliError(
        'this deletes every stored secret; the credentials that held one must be added again. ' +
          'If the key file is lost for good, run: podium vault reset --confirm',
      )
    }
    const reply = await client.vault.reset.mutate({ confirm: true })
    return json
      ? JSON.stringify({ command: 'vault reset', ok: true, data: reply })
      : `Vault reset. ${reply.needsAttention} credential(s) need to be added again.`
  }
  throw new VaultCliError(`unknown command ${command ?? ''}; see podium vault --help`)
}

/** The `podium vault …` entry point. */
export async function vaultCliMain(argv: string[]): Promise<void> {
  if (isHelp(argv)) {
    console.log(vaultHelpText())
    return
  }
  try {
    const client = makeOperatorIssueClient(localServerUrl(resolvePort())) as unknown as VaultClient
    console.log(await runVaultCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `podium vault ${argv[0]}: ${
        error instanceof VaultCliError
          ? message
          : `${message} (this command talks to the local server over /trpc — is it running? \`podium status\`)`
      }`,
    )
    process.exitCode = 1
  }
}
