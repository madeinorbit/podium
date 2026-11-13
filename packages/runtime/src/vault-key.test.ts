import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './sqlite'
import {
  fileKeyProvider,
  readWrappedDataKey,
  resolveVaultKeyPath,
  VaultKeyError,
  vaultCheckValue,
  writeWrappedDataKey,
} from './vault-key'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'vault-key-'))
const modeOf = (path: string): number => statSync(path).mode & 0o777

/** A key file as `fileKeyProvider` writes it: one line of base64 over 32 bytes. */
function plantKeyFile(path: string, mode = 0o600, bytes = randomBytes(32)): void {
  writeFileSync(path, `${bytes.toString('base64')}\n`, { mode })
  chmodSync(path, mode)
}

describe('resolveVaultKeyPath', () => {
  it('uses PODIUM_VAULT_KEY_FILE when it is set', () => {
    expect(
      resolveVaultKeyPath(
        { PODIUM_VAULT_KEY_FILE: '/run/secrets/podium.key', XDG_CONFIG_HOME: '/x', HOME: '/h' },
        'default',
      ),
    ).toBe('/run/secrets/podium.key')
  })

  it('uses $XDG_CONFIG_HOME/podium/vault-<instance>.key next', () => {
    expect(resolveVaultKeyPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/h' }, 'staging')).toBe(
      '/x/cfg/podium/vault-staging.key',
    )
  })

  it('falls back to ~/.config/podium/vault-<instance>.key', () => {
    expect(resolveVaultKeyPath({ HOME: '/home/someone' }, 'default')).toBe(
      '/home/someone/.config/podium/vault-default.key',
    )
  })

  it('ignores blank values', () => {
    expect(
      resolveVaultKeyPath({ PODIUM_VAULT_KEY_FILE: '  ', XDG_CONFIG_HOME: '', HOME: '/h' }, 'a'),
    ).toBe('/h/.config/podium/vault-a.key')
  })
})

describe('fileKeyProvider', () => {
  it('creates the key file 0600 in a new 0700 directory on the first wrap', async () => {
    const dir = join(scratch(), 'cfg', 'podium')
    const path = join(dir, 'vault-default.key')
    const provider = await fileKeyProvider(path)
    expect(existsSync(path)).toBe(false)

    const dataKey = randomBytes(32)
    const wrapped = await provider.wrap(dataKey)

    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(dir)).toBe(0o700)
    expect(provider.keyId).toMatch(/^file:[0-9a-f]{16}$/)
    expect(Buffer.compare(await provider.unwrap(wrapped), dataKey)).toBe(0)
    expect(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')).toHaveLength(32)
  })

  it('opens an existing key file and keeps its id across providers', async () => {
    const path = join(scratch(), 'vault.key')
    plantKeyFile(path)
    const first = await fileKeyProvider(path)
    const wrapped = await first.wrap(Buffer.alloc(32, 7))
    const second = await fileKeyProvider(path)
    expect(second.keyId).toBe(first.keyId)
    expect(await second.unwrap(wrapped)).toEqual(Buffer.alloc(32, 7))
  })

  it.each([
    0o640, 0o604, 0o660,
  ])('refuses a key file with mode %o and names the file', async (mode) => {
    const path = join(scratch(), 'vault.key')
    plantKeyFile(path, mode)
    const failure = await fileKeyProvider(path).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(VaultKeyError)
    expect((failure as VaultKeyError).reason).toBe('permissions')
    expect((failure as VaultKeyError).message).toContain(path)
  })

  it.each([
    ['an empty file', (path: string) => writeFileSync(path, '', { mode: 0o600 })],
    ['a 31-byte key', (path: string) => plantKeyFile(path, 0o600, randomBytes(31))],
    ['a directory', (path: string) => mkdirSync(path, { mode: 0o700 })],
  ])('refuses %s as malformed and names the file', async (_label, plant) => {
    const path = join(scratch(), 'vault.key')
    plant(path)
    const failure = await fileKeyProvider(path).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(VaultKeyError)
    expect((failure as VaultKeyError).reason).toBe('malformed')
    expect((failure as VaultKeyError).message).toContain(path)
  })

  it('does not create a key file to unwrap with when the file is missing', async () => {
    const path = join(scratch(), 'missing', 'vault.key')
    const provider = await fileKeyProvider(path)
    const failure = await provider.unwrap(randomBytes(60)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(VaultKeyError)
    expect((failure as VaultKeyError).reason).toBe('missing')
    expect((failure as VaultKeyError).message).toContain(path)
    expect(existsSync(path)).toBe(false)
  })

  it('does not open a data key wrapped under another key file', async () => {
    const a = join(scratch(), 'a.key')
    const b = join(scratch(), 'b.key')
    plantKeyFile(a)
    plantKeyFile(b)
    const wrapped = await (await fileKeyProvider(a)).wrap(randomBytes(32))
    await expect((await fileKeyProvider(b)).unwrap(wrapped)).rejects.toThrow()
  })
})

describe('the wrapped data key row', () => {
  const VAULT_KEY_DDL = `CREATE TABLE vault_key (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    key_id TEXT NOT NULL,
    wrapped_data_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`

  it('round-trips through writeWrappedDataKey and readWrappedDataKey', async () => {
    const db = openDatabase(':memory:')
    db.exec(VAULT_KEY_DDL)
    expect(readWrappedDataKey(db)).toBeNull()

    const path = join(scratch(), 'vault.key')
    const provider = await fileKeyProvider(path)
    const dataKey = randomBytes(32)
    await writeWrappedDataKey(db, provider, dataKey)

    const row = readWrappedDataKey(db)
    expect(row?.keyId).toBe(provider.keyId)
    expect(await provider.unwrap(row?.wrapped ?? Buffer.alloc(0))).toEqual(dataKey)
  })

  it('replaces the one row rather than adding a second', async () => {
    const db = openDatabase(':memory:')
    db.exec(VAULT_KEY_DDL)
    const provider = await fileKeyProvider(join(scratch(), 'vault.key'))
    await writeWrappedDataKey(db, provider, randomBytes(32))
    const second = randomBytes(32)
    await writeWrappedDataKey(db, provider, second)
    expect(db.prepare('SELECT count(*) AS n FROM vault_key').get()).toEqual({ n: 1 })
    expect(await provider.unwrap(readWrappedDataKey(db)?.wrapped ?? Buffer.alloc(0))).toEqual(
      second,
    )
  })
})

describe('vaultCheckValue', () => {
  it('is a stable HMAC-SHA256 in hex that changes with the transfer id and the key', () => {
    const key = Buffer.alloc(32, 1)
    expect(vaultCheckValue(key, 't1')).toMatch(/^[0-9a-f]{64}$/)
    expect(vaultCheckValue(key, 't1')).toBe(vaultCheckValue(Buffer.alloc(32, 1), 't1'))
    expect(vaultCheckValue(key, 't2')).not.toBe(vaultCheckValue(key, 't1'))
    expect(vaultCheckValue(Buffer.alloc(32, 2), 't1')).not.toBe(vaultCheckValue(key, 't1'))
  })
})
