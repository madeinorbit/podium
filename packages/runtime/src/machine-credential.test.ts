import { createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createMachineCredential,
  readMachineCredential,
  MACHINE_KEY_FILE,
  MACHINE_SIGNATURE_PREFIX,
  machinePublicKeyWire,
  signWithMachine,
  verifyWithMachineKey,
} from './machine-credential'
import {
  CONNECT_REQUEST_PREFIX,
  readOrCreateInstallationIdentity,
  installationPublicKeyWire,
  signWithInstallation,
} from './installation-identity'
import {
  isSigningKeyPair,
  mintSigningKeyPair,
  parseWirePublicKey,
  publicKeyWire,
  verifyWithWireKey,
} from './signing'
import vectors from './fixtures/machine-signing-vectors.json'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

const dirs: string[] = []
function directory(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'machine-credential-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

it('reads without minting and creates a stable private key only on explicit enrollment', () => {
  const dir = directory()
  expect(readMachineCredential(dir)).toBeUndefined()
  expect(fs.readdirSync(dir)).toEqual([])
  const key = createMachineCredential(dir)
  expect(createMachineCredential(dir)).toEqual(key)
  expect(readMachineCredential(dir)).toEqual(key)
  expect(fs.statSync(join(dir, MACHINE_KEY_FILE)).mode & 0o777).toBe(0o600)
  expect(createMachineCredential(directory()).publicKey).not.toBe(key.publicKey)
})

it('keeps machine and installation storage and trust roots separate', () => {
  const dir = directory()
  const installation = readOrCreateInstallationIdentity(dir)
  const machine = createMachineCredential(join(dir, 'credentials'))
  expect(machine.publicKey).not.toBe(installation.publicKey)
  expect(
    verifyWithMachineKey(machinePublicKeyWire(machine), 'hello', signWithMachine(machine, 'hello')),
  ).toBe(true)
  expect(
    verifyWithMachineKey(
      installationPublicKeyWire(installation),
      'hello',
      signWithMachine(machine, 'hello'),
    ),
  ).toBe(false)
  expect(
    verifyWithMachineKey(
      machinePublicKeyWire(machine),
      'hello',
      signWithInstallation(machine, CONNECT_REQUEST_PREFIX, 'hello'),
    ),
  ).toBe(false)
})

it.each([
  '{',
  '{}',
  JSON.stringify({ version: 2, ...mintSigningKeyPair() }),
  JSON.stringify({
    version: 1,
    ...mintSigningKeyPair(),
    publicKey: mintSigningKeyPair().publicKey,
  }),
])('never replaces corrupt persisted data: %s', (raw) => {
  const dir = directory(),
    path = join(dir, MACHINE_KEY_FILE)
  fs.writeFileSync(path, raw)
  expect(() => readMachineCredential(dir)).toThrow(/invalid persisted machine credential/)
  expect(() => createMachineCredential(dir)).toThrow(/invalid persisted machine credential/)
  expect(fs.readFileSync(path, 'utf8')).toBe(raw)
})

it('rejects valid keys of another algorithm', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  expect(
    isSigningKeyPair({
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    }),
  ).toBe(false)
})

it('uses exclusive creation and reads the winner of an actual write collision', async () => {
  const dir = directory(),
    winner = createMachineCredential(directory())
  const { writeFileSync: write } = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((path, data, options) => {
    expect(options).toEqual({ mode: 0o600, flag: 'wx' })
    write(path, JSON.stringify(winner), { mode: 0o600 })
    write(path, data, options)
  })
  expect(createMachineCredential(dir)).toEqual(winner)
})

it('propagates write failures without inventing a credential', () => {
  const error = Object.assign(new Error('denied'), { code: 'EACCES' })
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw error
  })
  expect(() => createMachineCredential(directory())).toThrow(error)
})

it('matches the machine vector, independently verifies with Web Crypto, and separates domains', async () => {
  const pair = { privateKey: vectors.privateKeyPkcs8 }
  expect(MACHINE_SIGNATURE_PREFIX).toBe(vectors.prefix)
  expect(signWithMachine(pair, vectors.message)).toBe(vectors.signature)
  expect(verifyWithMachineKey(vectors.publicKeyWire, vectors.message, vectors.signature)).toBe(true)
  expect(
    verifyWithWireKey(
      vectors.publicKeyWire,
      CONNECT_REQUEST_PREFIX,
      vectors.message,
      vectors.signature,
    ),
  ).toBe(false)
  expect(
    verifyWithMachineKey(vectors.publicKeyWire, vectors.message + '!', vectors.signature),
  ).toBe(false)
  const parsed = parseWirePublicKey(vectors.publicKeyWire)!
  expect(
    publicKeyWire({ publicKey: parsed.export({ type: 'spki', format: 'der' }).toString('base64') }),
  ).toBe(vectors.publicKeyWire)
  const key = await webcrypto.subtle.importKey(
    'jwk',
    createPublicKey(parsed.export({ type: 'spki', format: 'pem' })).export({ format: 'jwk' }),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  expect(
    await webcrypto.subtle.verify(
      'Ed25519',
      key,
      Buffer.from(vectors.signature, 'base64url'),
      Buffer.from(vectors.prefix + vectors.message),
    ),
  ).toBe(true)
})
