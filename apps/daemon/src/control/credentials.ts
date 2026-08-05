import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  declaredValue,
  hasValidClaudeCredential,
  hasValidCodexCredential,
  manifestFor,
} from '@podium/harness'
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import type { ControlHandlers } from './context'
import { reportInventory } from './inventory'

const MAX_CREDENTIAL_BYTES = 1_000_000

const PORTABLE_CREDENTIAL_PATHS: Record<PortableCredentialKind, (home: string) => string> = {
  codex: (home) => join(process.env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json'),
  grok: (home) => join(process.env.GROK_HOME?.trim() || join(home, '.grok'), 'auth.json'),
  'claude-code-state': (home) => join(home, '.claude.json'),
  'claude-code': (home) =>
    join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), '.credentials.json'),
}

export interface PortableCredentialOptions {
  /** Use the user's real native home, never a configured/managed redirect. */
  realHome?: boolean
  /** Apply propagation-only validity, freshness, and CAS guards. */
  guarded?: boolean
}

function credentialPath(
  kind: PortableCredentialKind,
  home: string,
  options: PortableCredentialOptions = {},
): string {
  if (options.realHome) {
    switch (kind) {
      case 'codex':
        return join(home, '.codex', 'auth.json')
      case 'claude-code':
        return join(home, '.claude', '.credentials.json')
      case 'claude-code-state':
        return join(home, '.claude.json')
      case 'grok':
        return join(home, '.grok', 'auth.json')
    }
  }
  return PORTABLE_CREDENTIAL_PATHS[kind](home)
}

function validCredential(kind: PortableCredentialKind, contents: string): boolean {
  if (kind === 'codex') return hasValidCodexCredential(contents)
  if (kind === 'claude-code') return hasValidClaudeCredential(contents)
  return false
}

function propagationComparator(kind: PortableCredentialKind) {
  const declared = manifestFor(kind)?.inventory.portableCredential
  return declared ? declaredValue(declared)?.compareFreshness : undefined
}

interface CredentialSnapshot {
  exists: boolean
  contents?: Buffer
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function snapshot(path: string): CredentialSnapshot {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) return { exists: true }
    return { exists: true, contents: readFileSync(path) }
  } catch (error: unknown) {
    // Only a genuinely absent path is an empty compare-and-swap value. A
    // permissions error, directory race, or other read failure must not turn
    // into permission to overwrite a file we could not inspect.
    return isMissingPath(error) ? { exists: false } : { exists: true }
  }
}

function sameSnapshot(a: CredentialSnapshot, b: CredentialSnapshot): boolean {
  if (a.exists !== b.exists) return false
  if (!a.exists) return true
  if (a.contents === undefined || b.contents === undefined) return false
  return a.contents.equals(b.contents)
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

function guardedInstall(bundle: PortableCredentialBundle, path: string, content: Buffer): boolean {
  if (bundle.kind !== 'codex' && bundle.kind !== 'claude-code') {
    throw new Error('credential propagation only supports native Codex and Claude files')
  }
  const before = snapshot(path)
  if (before.contents && validCredential(bundle.kind, before.contents.toString('utf8'))) {
    return false
  }
  if (before.exists) {
    if (!before.contents) return false
    const compare = propagationComparator(bundle.kind)
    if (!compare || compare(content.toString('utf8'), before.contents.toString('utf8')) !== 1) {
      return false
    }
  }

  // The second read is the compare-and-swap fence. A local CLI rotation that
  // landed after the first read wins; the propagation refuses to replace it.
  const again = snapshot(path)
  if (!sameSnapshot(before, again)) return false
  if (again.contents && validCredential(bundle.kind, again.contents.toString('utf8'))) {
    return false
  }
  if (again.exists) {
    if (!again.contents) return false
    const compare = propagationComparator(bundle.kind)
    if (!compare || compare(content.toString('utf8'), again.contents.toString('utf8')) !== 1) {
      return false
    }
  }
  atomicInstall(path, content)
  return true
}

function sanitizedClaudeState(value: unknown): Record<string, boolean | string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Claude state is not an object')
  }
  const source = value as Record<string, unknown>
  if (source.hasCompletedOnboarding !== true) {
    throw new Error('Claude onboarding is not complete on the source machine')
  }
  const result: Record<string, boolean | string> = { hasCompletedOnboarding: true }
  if (
    typeof source.lastOnboardingVersion === 'string' &&
    source.lastOnboardingVersion.length <= 64
  ) {
    result.lastOnboardingVersion = source.lastOnboardingVersion
  }
  if (typeof source.installMethod === 'string' && source.installMethod.length <= 32) {
    result.installMethod = source.installMethod
  }
  return result
}

export function readPortableCredential(
  kind: PortableCredentialKind,
  home: string,
  options: PortableCredentialOptions = {},
): PortableCredentialBundle | null {
  if (options.guarded && kind !== 'codex' && kind !== 'claude-code') return null
  const path = credentialPath(kind, home, options)
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_BYTES) return null
  let content = readFileSync(path)
  const parsed = JSON.parse(content.toString('utf8')) // only valid JSON auth files cross the wire
  if (options.guarded && !validCredential(kind, content.toString('utf8'))) return null
  if (kind === 'claude-code-state') {
    content = Buffer.from(JSON.stringify(sanitizedClaudeState(parsed)))
  }
  return { kind, contentBase64: content.toString('base64') }
}

export function installPortableCredential(
  bundle: PortableCredentialBundle,
  home: string,
  options: PortableCredentialOptions = {},
): boolean {
  const content = Buffer.from(bundle.contentBase64, 'base64')
  if (content.length <= 0 || content.length > MAX_CREDENTIAL_BYTES) {
    throw new Error('credential payload has an invalid size')
  }
  const parsed = JSON.parse(content.toString('utf8'))
  const path = credentialPath(bundle.kind, home, options)
  if (options.guarded) {
    if (!validCredential(bundle.kind, content.toString('utf8'))) {
      throw new Error('credential propagation payload is not a valid native login')
    }
    return guardedInstall(bundle, path, content)
  }

  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const installedContent = (() => {
    if (bundle.kind !== 'claude-code-state') return content
    const portable = sanitizedClaudeState(parsed)
    let existing: Record<string, unknown> = {}
    if (existsSync(path)) {
      const stat = lstatSync(path)
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_CREDENTIAL_BYTES) {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          existing = value as Record<string, unknown>
        }
      }
    }
    return Buffer.from(JSON.stringify({ ...existing, ...portable }, null, 2) + '\n')
  })()
  atomicInstall(path, installedContent)
  return true
}
export const credentialHandlers: Pick<
  ControlHandlers,
  'credentialExportRequest' | 'credentialInstallRequest'
> = {
  credentialExportRequest: (ctx, msg) => {
    const home = ctx.homeDir ?? homedir()
    const bundles: PortableCredentialBundle[] = []
    const unavailable: PortableCredentialKind[] = []
    for (const kind of msg.kinds) {
      try {
        const bundle = readPortableCredential(kind, home, {
          realHome: msg.propagation === true,
          guarded: msg.propagation === true,
        })
        if (bundle) bundles.push(bundle)
        else unavailable.push(kind)
      } catch {
        unavailable.push(kind)
      }
    }
    ctx.send({ type: 'credentialExportResult', requestId: msg.requestId, bundles, unavailable })
  },
  credentialInstallRequest: (ctx, msg) => {
    const home = ctx.homeDir ?? homedir()
    const installed: PortableCredentialKind[] = []
    const failed: PortableCredentialKind[] = []
    for (const bundle of msg.bundles) {
      try {
        const didInstall = installPortableCredential(bundle, home, {
          realHome: msg.propagation === true,
          guarded: msg.propagation === true,
        })
        if (didInstall) installed.push(bundle.kind)
        else failed.push(bundle.kind)
      } catch {
        failed.push(bundle.kind)
      }
    }
    ctx.send({ type: 'credentialInstallResult', requestId: msg.requestId, installed, failed })
    if (installed.length > 0) void reportInventory(ctx, { rebuild: true })
  },
}
