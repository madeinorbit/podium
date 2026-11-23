/**
 * THE SERVER STARTS WHATEVER STATE ITS VAULT KEY IS IN (POD-6889; design §7,
 * review focus 6). A real booted server, because "the server still starts" is a
 * claim about the whole boot, not about the store alone.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { sealCredentialSecret, VaultLockedError, withSecret } from './modules/credentials/vault'
import { startServer } from './server'
import { installSetupEnrollmentParent } from './test-support/setup-enrollment-parent'

const priorStateDir = process.env.PODIUM_STATE_DIR!
const priorKeyFile = process.env.PODIUM_VAULT_KEY_FILE

interface Readiness {
  dataPlane: string
}

describe('booting with a vault key that cannot be used', () => {
  const cleanups: (() => Promise<void> | void)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorKeyFile === undefined) delete process.env.PODIUM_VAULT_KEY_FILE
    else process.env.PODIUM_VAULT_KEY_FILE = priorKeyFile
  })

  function prepare(): { stateDir: string; keyPath: string } {
    const stateDir = mkdtempSync(join(tmpdir(), 'podium-vault-boot-'))
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one' }),
    )
    const keyPath = join(mkdtempSync(join(tmpdir(), 'podium-vault-key-')), 'podium', 'vault.key')
    process.env.PODIUM_STATE_DIR = stateDir
    process.env.PODIUM_VAULT_KEY_FILE = keyPath
    const parent = installSetupEnrollmentParent(stateDir)
    cleanups.push(() => {
      parent.dispose()
      rmSync(stateDir, { recursive: true, force: true })
    })
    return { stateDir, keyPath }
  }

  async function boot() {
    const handle = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await handle.close()
    }
    cleanups.push(close)
    const readiness = (await (
      await fetch(`http://127.0.0.1:${handle.port}/readiness`)
    ).json()) as Readiness
    return { store: handle.registry.sessionStore, readiness, close }
  }

  it('starts with a key file others can read, and names the file', async () => {
    const { keyPath } = prepare()
    mkdirSync(join(keyPath, '..'), { recursive: true })
    writeFileSync(keyPath, `${randomBytes(32).toString('base64')}\n`)
    chmodSync(keyPath, 0o644)

    const { store, readiness } = await boot()
    expect(readiness.dataPlane).toBe('available')
    expect(store.vault.status()).toMatchObject({ keyPath, state: 'empty' })
    expect(store.vault.status().problem).toContain(keyPath)
    expect(store.vault.status().problem).toContain('chmod 600')
  })

  it('starts locked when the key file is gone, and creates no new key', async () => {
    const { keyPath } = prepare()
    const first = await boot()
    const admin = await firstAdminMemberId(first.store)
    const stored = await first.store.credentials.insert({
      ownerUserId: admin,
      label: 'Stored',
      type: 'anthropic.api-key',
    })
    expect(await sealCredentialSecret(first.store, stored, 'FAKE-sk-boot-0001', 0)).toBe(1)
    await first.close()
    rmSync(keyPath)

    const { store, readiness } = await boot()
    expect(readiness.dataPlane).toBe('available')
    expect(store.vault.state()).toBe('locked')
    expect(store.vault.status().problem).toContain(keyPath)
    expect((await store.credentials.latestSecret(stored.id))?.openable).toBe(false)
    await expect(withSecret(store, stored.id, async (s) => s)).rejects.toThrow(/needs attention/)

    const another = await store.credentials.insert({
      ownerUserId: admin,
      label: 'New',
      type: 'openai.api-key',
    })
    const refusal = await sealCredentialSecret(store, another, 'FAKE-sk-boot-0002', 0).catch(
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(VaultLockedError)
    expect((refusal as Error).message).toContain(keyPath)
    expect(existsSync(keyPath)).toBe(false)
  })
})
