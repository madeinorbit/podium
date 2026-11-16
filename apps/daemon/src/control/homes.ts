/**
 * THE HOME REQUESTS (credential management §8 "What Podium leaves on
 * machines, and cleanup" and §10 "Homes"; epic plan Task 8).
 *
 * The server asks for a home to exist (`homeEnsureRequest`, before a sign-in
 * or a session on a credential), for one to go (`homeRemoveRequest`, when the
 * credential is removed everywhere), and for a login file propagation copied
 * to go (`credentialRemoveRequest`). Every one answers, so the server's
 * placement records move only on the machine's confirmation. Sent only to a
 * daemon that offered `CAP_HARNESS_HOMES`.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  credentialFileReader,
  declaredValue,
  manifestFor,
  resolveCredentialFilePath,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { CredentialRemoveOutcome, HomeHarness } from '@podium/protocol'
import { resolveManagementCredentialHome } from '../harness-management'
import type { ControlHandlers, DaemonContext } from './context'
import { reportInventory } from './inventory'

const log = createLogger('daemon:homes')

const NO_HOMES = 'Podium on this machine keeps no harness homes.'

/** Publish the inventory again: its `logins` changed. Never fails a reply. */
function republish(ctx: DaemonContext): void {
  if (!ctx.harnessRuntime) return
  void reportInventory(ctx, { rebuild: true }).catch((err: unknown) =>
    log.warn('inventory after a home change failed', { err }),
  )
}

export const homeHandlers: Pick<
  ControlHandlers,
  'homeEnsureRequest' | 'homeRemoveRequest' | 'credentialRemoveRequest'
> = {
  homeEnsureRequest: (ctx, msg) => {
    void (async () => {
      if (!ctx.homes) {
        ctx.send({ type: 'homeEnsureResult', requestId: msg.requestId, ok: false, error: NO_HOMES })
        return
      }
      try {
        const { home, created } = await ctx.homes.ensure(msg.credentialId, msg.harness)
        ctx.send({
          type: 'homeEnsureResult',
          requestId: msg.requestId,
          ok: true,
          homeId: home.homeId,
          created,
        })
        if (created) republish(ctx)
      } catch (error) {
        ctx.send({
          type: 'homeEnsureResult',
          requestId: msg.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  },

  homeRemoveRequest: (ctx, msg) => {
    void (async () => {
      if (!ctx.homes) {
        ctx.send({ type: 'homeRemoveResult', requestId: msg.requestId, ok: false, error: NO_HOMES })
        return
      }
      try {
        const { removed, freedBytes } = await ctx.homes.remove(msg.homeId)
        ctx.send({
          type: 'homeRemoveResult',
          requestId: msg.requestId,
          ok: true,
          removed,
          freedBytes,
        })
        if (removed) {
          log.info('removed a harness home', { homeId: msg.homeId, freedBytes })
          republish(ctx)
        }
      } catch (error) {
        ctx.send({
          type: 'homeRemoveResult',
          requestId: msg.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  },

  credentialRemoveRequest: (ctx, msg) => {
    void removePropagatedLogin(ctx, msg.harness, msg.fingerprint).then(({ outcome, error }) => {
      ctx.send({
        type: 'credentialRemoveResult',
        requestId: msg.requestId,
        outcome,
        ...(error ? { error } : {}),
      })
      if (outcome === 'removed') republish(ctx)
    })
  },
}

/**
 * Remove the login file propagation copied for `harness`, only while the login
 * it holds still has `fingerprint`.
 *
 * Where propagation wrote it: the harness's own directory under the account's
 * credential home, by the file's declared default location (`realHome`, no
 * directory variable followed), which is never a Podium home. Only the one
 * allowlisted (`propagatable`) file goes; Claude Code's state file and
 * anything else stay. A login someone signed in to since has another
 * fingerprint, or none, and is left as it is.
 */
export async function removePropagatedLogin(
  ctx: Pick<DaemonContext, 'accountHome' | 'homeDir'>,
  harness: HomeHarness,
  fingerprint: string,
): Promise<{ outcome: CredentialRemoveOutcome; error?: string }> {
  const manifest = manifestFor(harness)
  const section = manifest ? declaredValue(manifest.credentials) : undefined
  const file = section?.files.find((candidate) => candidate.propagatable)
  if (!section || !file) return { outcome: 'failed', error: `${harness} has no login file` }
  if (harness === 'claude-code' && process.platform === 'darwin') {
    // On macOS the login propagation installed is in the Keychain, not a file:
    // leaving the placement pending is honest, deleting a file would not be.
    return { outcome: 'failed', error: 'a Claude Code login on macOS is not a file' }
  }
  const home = resolveManagementCredentialHome(ctx) ?? homedir()
  const path = resolveCredentialFilePath(file, home, { realHome: true })
  let present: string | undefined
  try {
    present = section.identity(credentialFileReader(section, home, {}))?.fingerprint
  } catch {
    present = undefined
  }
  if (!existsSync(path)) return { outcome: 'absent' }
  if (present !== fingerprint) return { outcome: 'changed' }
  try {
    await rm(path, { force: true })
    return { outcome: 'removed' }
  } catch (error) {
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
