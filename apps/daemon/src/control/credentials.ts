import { homedir, platform as currentPlatform, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  declaredValue,
  hasValidClaudeCredential,
  hasValidCodexCredential,
  manifestFor,
} from '@podium/harness'
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import { ClaudeKeychainCredentialStore } from './claude-keychain-credential-store'
import type { ClaudeStorageLockFactory } from './claude-keychain-lock'
import type { SecurityRunner } from './claude-keychain-security'
import {
  FileCredentialStore,
  MAX_CREDENTIAL_BYTES,
  type PortableCredentialStore,
} from './credential-store'
import type { ControlHandlers, DaemonContext } from './context'
import { reportInventory } from './inventory'

const PORTABLE_CREDENTIAL_PATHS: Record<
  PortableCredentialKind,
  (home: string, env: Readonly<Record<string, string | undefined>>) => string
> = {
  codex: (home, env) => join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json'),
  grok: (home, env) => join(env.GROK_HOME?.trim() || join(home, '.grok'), 'auth.json'),
  'claude-code-state': (home) => join(home, '.claude.json'),
  'claude-code': (home, env) =>
    join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), '.credentials.json'),
}

const REAL_PORTABLE_CREDENTIAL_PATHS: Record<PortableCredentialKind, (home: string) => string> = {
  codex: (home) => join(home, '.codex', 'auth.json'),
  grok: (home) => join(home, '.grok', 'auth.json'),
  'claude-code-state': (home) => join(home, '.claude.json'),
  'claude-code': (home) => join(home, '.claude', '.credentials.json'),
}

const PROPAGATABLE_CREDENTIAL_KINDS: ReadonlySet<PortableCredentialKind> = new Set([
  'claude-code',
  'codex',
])

const CREDENTIAL_VALIDATORS: Partial<Record<PortableCredentialKind, (value: string) => boolean>> = {
  'claude-code': hasValidClaudeCredential,
  codex: hasValidCodexCredential,
}

export interface PortableCredentialOptions {
  /** Use the user's real native home, never a configured/managed file redirect. */
  realHome?: boolean
  /** Apply propagation-only validity, freshness, and CAS guards. */
  guarded?: boolean
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  osUsername?: string
  resolvedClaudeVersion?: string
  securityRunner?: SecurityRunner
  claudeLockFactory?: ClaudeStorageLockFactory
  allowLegacyClaudeServiceFallback?: boolean
}

function credentialPath(
  kind: PortableCredentialKind,
  home: string,
  options: PortableCredentialOptions,
): string {
  const paths = options.realHome ? REAL_PORTABLE_CREDENTIAL_PATHS : PORTABLE_CREDENTIAL_PATHS
  return paths[kind](home, options.env ?? process.env)
}

function validCredential(kind: PortableCredentialKind, contents: string): boolean {
  return CREDENTIAL_VALIDATORS[kind]?.(contents) ?? false
}

function propagationComparator(kind: PortableCredentialKind) {
  const declared = manifestFor(kind)?.inventory.portableCredential
  return declared ? declaredValue(declared)?.compareFreshness : undefined
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

function strictBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('credential payload is not canonical base64')
  }
  return Buffer.from(value, 'base64')
}

function defaultUsername(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

function credentialStore(
  kind: PortableCredentialKind,
  home: string,
  options: PortableCredentialOptions,
): PortableCredentialStore {
  const platform = options.platform ?? currentPlatform()
  if (kind === 'claude-code' && platform === 'darwin') {
    return new ClaudeKeychainCredentialStore({
      home,
      env: options.env ?? process.env,
      osUsername: options.osUsername ?? defaultUsername(),
      resolvedClaudeVersion: options.resolvedClaudeVersion,
      runner: options.securityRunner,
      lockFactory: options.claudeLockFactory,
      allowLegacyFallback: options.allowLegacyClaudeServiceFallback,
    })
  }
  return new FileCredentialStore(credentialPath(kind, home, options))
}

export async function readPortableCredential(
  kind: PortableCredentialKind,
  home: string,
  options: PortableCredentialOptions = {},
): Promise<PortableCredentialBundle | null> {
  if (options.guarded && !PROPAGATABLE_CREDENTIAL_KINDS.has(kind)) return null
  const read = await credentialStore(kind, home, options).read()
  if (read.state === 'absent') return null
  if (read.state === 'unavailable') throw new Error(`credential store unavailable: ${read.reason}`)
  try {
    if (read.contents.length <= 0 || read.contents.length > MAX_CREDENTIAL_BYTES) return null
    const text = read.contents.toString('utf8')
    const parsed = JSON.parse(text) as unknown
    if (options.guarded && !validCredential(kind, text)) return null
    const content =
      kind === 'claude-code-state'
        ? Buffer.from(JSON.stringify(sanitizedClaudeState(parsed)))
        : read.contents
    return { kind, contentBase64: content.toString('base64') }
  } finally {
    read.contents.fill(0)
  }
}

export async function installPortableCredential(
  bundle: PortableCredentialBundle,
  home: string,
  options: PortableCredentialOptions = {},
): Promise<boolean> {
  const content = strictBase64(bundle.contentBase64)
  try {
    if (content.length <= 0 || content.length > MAX_CREDENTIAL_BYTES) {
      throw new Error('credential payload has an invalid size')
    }
    const text = content.toString('utf8')
    const parsed = JSON.parse(text) as unknown
    const store = credentialStore(bundle.kind, home, options)
    if (options.guarded) {
      if (!PROPAGATABLE_CREDENTIAL_KINDS.has(bundle.kind)) {
        throw new Error('credential propagation only supports native Codex and Claude files')
      }
      if (!validCredential(bundle.kind, text)) {
        throw new Error('credential propagation payload is not a valid native login')
      }
      return await store.guardedInstall(content, {
        valid: (current) => validCredential(bundle.kind, current),
        compareFreshness: propagationComparator(bundle.kind),
      })
    }

    if (bundle.kind !== 'claude-code-state') return await store.install(content)
    const portable = sanitizedClaudeState(parsed)
    const existing = await store.read()
    try {
      let local: Record<string, unknown> = {}
      if (existing.state === 'present' && existing.contents.length > 0) {
        const value = JSON.parse(existing.contents.toString('utf8')) as unknown
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          local = value as Record<string, unknown>
        }
      }
      return await store.install(
        Buffer.from(JSON.stringify({ ...local, ...portable }, null, 2) + '\n'),
      )
    } finally {
      if (existing.state === 'present') existing.contents.fill(0)
    }
  } finally {
    content.fill(0)
  }
}

async function runtimeOptions(ctx: DaemonContext): Promise<PortableCredentialOptions> {
  const snapshot = await ctx.harnessRuntime?.current().catch(() => undefined)
  return {
    platform: currentPlatform(),
    env: snapshot?.commandEnvironment.env ?? process.env,
    resolvedClaudeVersion: snapshot?.executables.get('claude-code')?.version,
  }
}

export async function handleCredentialExport(
  ctx: DaemonContext,
  msg: Parameters<NonNullable<ControlHandlers['credentialExportRequest']>>[1],
): Promise<void> {
  const home = ctx.homeDir ?? homedir()
  const runtime = await runtimeOptions(ctx)
  const bundles: PortableCredentialBundle[] = []
  const unavailable: PortableCredentialKind[] = []
  for (const kind of msg.kinds) {
    try {
      const bundle = await readPortableCredential(kind, home, {
        ...runtime,
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
}

export async function handleCredentialInstall(
  ctx: DaemonContext,
  msg: Parameters<NonNullable<ControlHandlers['credentialInstallRequest']>>[1],
): Promise<void> {
  const home = ctx.homeDir ?? homedir()
  const runtime = await runtimeOptions(ctx)
  const installed: PortableCredentialKind[] = []
  const failed: PortableCredentialKind[] = []
  for (const bundle of msg.bundles) {
    try {
      const didInstall = await installPortableCredential(bundle, home, {
        ...runtime,
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
  if (installed.length > 0) await reportInventory(ctx, { rebuild: true }).catch(() => {})
}

export const credentialHandlers: Pick<
  ControlHandlers,
  'credentialExportRequest' | 'credentialInstallRequest'
> = {
  credentialExportRequest: (ctx, msg) => {
    void handleCredentialExport(ctx, msg)
  },
  credentialInstallRequest: (ctx, msg) => {
    void handleCredentialInstall(ctx, msg)
  },
}
