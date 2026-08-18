import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const MAX_CREDENTIAL_BYTES = 1_000_000

export type CredentialStoreFailure =
  | 'keychain-unavailable'
  | 'locked-or-denied'
  | 'malformed-output'
  | 'output-overflow'
  | 'timeout'
  | 'tool-failure'
  | 'unreadable'

export type CredentialReadResult =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly contents: Buffer; readonly revision: string }
  | { readonly state: 'unavailable'; readonly reason: CredentialStoreFailure }

export interface GuardedCredentialPolicy {
  readonly valid: (contents: string) => boolean
  readonly compareFreshness?: (candidate: string, current: string) => number | null
}

export interface PortableCredentialStore {
  read(): Promise<CredentialReadResult>
  install(content: Buffer): Promise<boolean>
  guardedInstall(content: Buffer, policy: GuardedCredentialPolicy): Promise<boolean>
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function revision(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function sameRead(a: CredentialReadResult, b: CredentialReadResult): boolean {
  if (a.state !== b.state) return false
  if (a.state === 'absent') return true
  if (a.state !== 'present' || b.state !== 'present') return false
  return a.revision === b.revision
}

function atomicInstall(path: string, content: Buffer): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const tmp = path + '.podium-' + process.pid + '-' + randomUUID()
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // rename already consumed it (or write never created it)
    }
  }
}

function allowedByGuard(
  snapshot: CredentialReadResult,
  content: Buffer,
  policy: GuardedCredentialPolicy,
): boolean {
  if (snapshot.state === 'unavailable') return false
  if (snapshot.state === 'absent') return true
  const current = snapshot.contents.toString('utf8')
  if (policy.valid(current)) return false
  return policy.compareFreshness?.(content.toString('utf8'), current) === 1
}

function releaseRead(result: CredentialReadResult): void {
  if (result.state === 'present') result.contents.fill(0)
}

export class FileCredentialStore implements PortableCredentialStore {
  constructor(private readonly path: string) {}

  async read(): Promise<CredentialReadResult> {
    try {
      const stat = lstatSync(this.path)
      if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) {
        return { state: 'unavailable', reason: 'unreadable' }
      }
      const contents = readFileSync(this.path)
      return { state: 'present', contents, revision: revision(contents) }
    } catch (error: unknown) {
      return isMissingPath(error)
        ? { state: 'absent' }
        : { state: 'unavailable', reason: 'unreadable' }
    }
  }

  async install(content: Buffer): Promise<boolean> {
    atomicInstall(this.path, content)
    return true
  }

  async guardedInstall(content: Buffer, policy: GuardedCredentialPolicy): Promise<boolean> {
    const before = await this.read()
    try {
      if (!allowedByGuard(before, content, policy)) return false

      // The second read is the compare-and-swap fence. A local CLI rotation
      // that landed after the first read wins.
      const again = await this.read()
      try {
        if (!sameRead(before, again) || !allowedByGuard(again, content, policy)) return false
        atomicInstall(this.path, content)
        return true
      } finally {
        releaseRead(again)
      }
    } finally {
      releaseRead(before)
    }
  }
}
