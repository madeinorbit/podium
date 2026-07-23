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
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import type { ControlHandlers } from './context'
import { reportInventory } from './inventory'

const MAX_CREDENTIAL_BYTES = 1_000_000

function credentialPath(kind: PortableCredentialKind, home: string): string {
  if (kind === 'codex') {
    return join(process.env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json')
  }
  if (kind === 'grok') {
    return join(process.env.GROK_HOME?.trim() || join(home, '.grok'), 'auth.json')
  }
  if (kind === 'claude-code-state') return join(home, '.claude.json')
  return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), '.credentials.json')
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
): PortableCredentialBundle | null {
  const path = credentialPath(kind, home)
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_BYTES) return null
  let content = readFileSync(path)
  const parsed = JSON.parse(content.toString('utf8')) // only valid JSON auth files cross the wire
  if (kind === 'claude-code-state') {
    content = Buffer.from(JSON.stringify(sanitizedClaudeState(parsed)))
  }
  return { kind, contentBase64: content.toString('base64') }
}

export function installPortableCredential(bundle: PortableCredentialBundle, home: string): void {
  const content = Buffer.from(bundle.contentBase64, 'base64')
  if (content.length <= 0 || content.length > MAX_CREDENTIAL_BYTES) {
    throw new Error('credential payload has an invalid size')
  }
  const parsed = JSON.parse(content.toString('utf8'))
  const path = credentialPath(bundle.kind, home)
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
    return Buffer.from(`${JSON.stringify({ ...existing, ...portable }, null, 2)}\n`)
  })()
  const tmp = `${path}.podium-${process.pid}`
  try {
    writeFileSync(tmp, installedContent, { mode: 0o600, flag: 'wx' })
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
        const bundle = readPortableCredential(kind, home)
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
        installPortableCredential(bundle, home)
        installed.push(bundle.kind)
      } catch {
        failed.push(bundle.kind)
      }
    }
    ctx.send({ type: 'credentialInstallResult', requestId: msg.requestId, installed, failed })
    if (installed.length > 0) void reportInventory(ctx, { rebuild: true })
  },
}
