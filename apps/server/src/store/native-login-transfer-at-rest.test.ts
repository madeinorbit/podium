/**
 * A native login copied between machines never rests in the database [POD-7044].
 *
 * Propagation carries the donor's login file (`PortableCredentialBundle`, the
 * bytes of a Codex `auth.json` or a Claude `.credentials.json`) from export to
 * install. It used to round-trip through a plain `server_secrets` row; a crash
 * left the row, and a later delete left the bytes in free pages. These tests
 * read the raw rows and the bytes of the database file and its sidecars.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asUserId, firstAdminMemberId, primeFirstAdminMember } from '@podium/model'
import type { PortableCredentialBundle } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LoginPropagationService } from '../modules/machines/login-propagation'
import { SessionStore } from '../store'

const owner = asUserId('user:owner')

/**
 * An obviously fake login file. Long enough that its row spills onto overflow
 * pages, which a delete frees whole rather than leaving inside a page.
 */
function fakeLoginFile(tag: string, padding: number): PortableCredentialBundle {
  const file = JSON.stringify({
    tokens: {
      access_token: `FAKE-access-${tag}`,
      refresh_token: `FAKE-refresh-${tag}`,
      id_token: `FAKE-id-${tag}-${'x'.repeat(padding)}`,
    },
  })
  return { kind: 'codex', contentBase64: Buffer.from(file).toString('base64') }
}

function place() {
  const dir = mkdtempSync(join(tmpdir(), 'login-transfer-at-rest-'))
  return { dbPath: join(dir, 'podium.db'), keyPath: join(dir, 'config', 'vault.key') }
}

/** The database file and its sidecars, as bytes, for the files that exist. */
function databaseBytes(dbPath: string): Buffer {
  return Buffer.concat(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path)),
  )
}

/**
 * The bundle's base64 text in 48-character fragments. A long row is split
 * across overflow pages, so the whole string is never contiguous in the file;
 * a fragment is, unless it straddles a page boundary.
 */
function fragments(bundle: PortableCredentialBundle): string[] {
  const text = bundle.contentBase64
  const out: string[] = []
  for (let at = 0; at + 48 <= text.length; at += 48) out.push(text.slice(at, at + 48))
  return out
}

/** The decoded secrets, in case anything wrote the login file itself. */
function decodedTokens(bundle: PortableCredentialBundle): string[] {
  const file = JSON.parse(Buffer.from(bundle.contentBase64, 'base64').toString('utf8')) as {
    tokens: Record<string, string>
  }
  return [file.tokens.access_token as string, file.tokens.refresh_token as string]
}

/** How many of the bundle's fragments and decoded tokens the bytes hold. */
function heldIn(bytes: Buffer, bundle: PortableCredentialBundle): number {
  return [...fragments(bundle), ...decodedTokens(bundle)].filter((needle) =>
    bytes.includes(Buffer.from(needle, 'utf8')),
  ).length
}

function rawSecretRows(dbPath: string): { key: string; value: string }[] {
  const db = openDatabase(dbPath)
  try {
    return db.prepare('SELECT key, value FROM server_secrets').all() as {
      key: string
      value: string
    }[]
  } finally {
    db.close()
  }
}

/** A transfer row as the versions before this fix wrote it. */
function plantOldTransferRow(dbPath: string, bundle: PortableCredentialBundle): string {
  const principal = createHash('sha256').update(owner).digest('hex')
  const key = `native-login-transfer:${principal}:${randomUUID()}`
  const db = openDatabase(dbPath)
  try {
    db.prepare('INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?)').run(
      key,
      JSON.stringify(bundle),
      '2026-11-01T00:00:00.000Z',
    )
  } finally {
    db.close()
  }
  return key
}

describe('a native login transfer at rest', () => {
  const open: SessionStore[] = []

  afterEach(async () => {
    for (const store of open.splice(0)) await store.close()
  })

  async function openAt(dbPath: string, keyPath: string): Promise<SessionStore> {
    const store = await SessionStore.open(dbPath, undefined, {
      vaultKeyFile: keyPath,
      changeCapture: 'whenLogAttaches',
    })
    primeFirstAdminMember(await firstAdminMemberId(store))
    open.push(store)
    return store
  }

  async function close(store: SessionStore): Promise<void> {
    open.splice(open.indexOf(store), 1)
    await store.close()
  }

  it('a propagation never writes the bundle to server_secrets or the database files', async () => {
    const { dbPath, keyPath } = place()
    const store = await openAt(dbPath, keyPath)
    for (const [id, login] of [
      ['donor', 'in'],
      ['target', 'out'],
    ] as const) {
      await store.machines.upsertMachine({
        id,
        name: id,
        hostname: id,
        tokenHash: `${id}-token`,
        ownerUserId: owner,
      })
      await store.machines.setMachineInventory(
        id,
        JSON.stringify({
          os: 'linux',
          arch: 'x64',
          podiumVersion: 'test',
          agents: [
            {
              kind: 'codex',
              installed: true,
              login: {
                state: login,
                ...(login === 'in'
                  ? { identity: { fingerprint: 'same-account', providerAccountId: 'acct' } }
                  : {}),
              },
            },
          ],
          tools: [],
        }),
      )
    }
    await store.accounts.setOptIn(owner, 'codex', 'same-account', true, new Date(0).toISOString())

    const bundle = fakeLoginFile('propagated', 6000)
    const atInstall: { rows: string[]; bytes: number; received: PortableCredentialBundle[] } = {
      rows: [],
      bytes: -1,
      received: [],
    }
    const svc = new LoginPropagationService({
      store,
      machines: {
        hasDaemon: () => true,
        capabilityRejection: async () => undefined,
        daemonSupports: () => true,
        // Both links are safe: this test is about the database, not the link.
        loginLinkUnsafe: () => undefined,
      },
      rpc: {
        credentialExport: async () => ({ bundles: [bundle], unavailable: [] }),
        // The moment the old code held the row: between export and install.
        credentialInstall: async (bundles) => {
          atInstall.received.push(...bundles)
          atInstall.rows = rawSecretRows(dbPath).map((row) => row.key)
          atInstall.bytes = heldIn(databaseBytes(dbPath), bundle)
          return { installed: ['codex'], failed: [] }
        },
      },
    })

    await expect(
      svc.propagate({ targetMachineId: asMachineId('target'), agentKind: 'codex' }),
    ).resolves.toMatchObject({ status: 'propagated' })

    // The target received the exact bytes the donor exported.
    expect(atInstall.received).toEqual([bundle])
    // While the transfer was in flight: no row, and no bytes in the files.
    // (Bytes first: on the old code this is the assertion that shows the search
    // reaches a row still in the WAL.)
    expect(atInstall.bytes).toBe(0)
    expect(atInstall.rows.filter((key) => key.startsWith('native-login-transfer:'))).toEqual([])
    // And after it, with the store closed and the WAL folded in.
    await close(store)
    expect(heldIn(databaseBytes(dbPath), bundle)).toBe(0)
  })

  it('a start deletes transfer rows an older version left, and their bytes with them', async () => {
    const { dbPath, keyPath } = place()
    await close(await openAt(dbPath, keyPath))
    const small = fakeLoginFile('small-left-behind', 0)
    const large = fakeLoginFile('large-left-behind', 9000)
    plantOldTransferRow(dbPath, small)
    plantOldTransferRow(dbPath, large)
    // Canary: before the start, the byte search finds most fragments of both
    // planted bundles (a fragment straddling a page boundary is not found).
    expect(heldIn(databaseBytes(dbPath), small)).toBeGreaterThan(fragments(small).length / 2)
    expect(heldIn(databaseBytes(dbPath), large)).toBeGreaterThan(fragments(large).length / 2)
    const otherRowsBefore = rawSecretRows(dbPath).filter(
      (row) => !row.key.startsWith('native-login-transfer:'),
    )

    const store = await openAt(dbPath, keyPath)
    // Gone from the rows while the store is open, and from the open files.
    expect(
      rawSecretRows(dbPath).filter((row) => row.key.startsWith('native-login-transfer:')),
    ).toEqual([])
    expect(heldIn(databaseBytes(dbPath), small)).toBe(0)
    expect(heldIn(databaseBytes(dbPath), large)).toBe(0)
    await close(store)

    expect(heldIn(databaseBytes(dbPath), small)).toBe(0)
    expect(heldIn(databaseBytes(dbPath), large)).toBe(0)
    // Nothing else in server_secrets was touched.
    expect(rawSecretRows(dbPath)).toEqual(otherRowsBefore)

    // A second start finds nothing to do and changes nothing.
    await close(await openAt(dbPath, keyPath))
    expect(rawSecretRows(dbPath)).toEqual(otherRowsBefore)
  })
})
