/**
 * Portable native credentials — the harness-free reader/writer (POD-4414 §4.4,
 * issue 3.3).
 *
 * This mechanism takes adapter SECTIONS and never a harness name: which files
 * back which portable bundle, what counts as valid, how two copies order, and
 * any harness-local access (the macOS keychain) are declared in
 * `adapters/<harness>/credentials.ts`. File choice is a lookup over those
 * declarations; kinds flow as values. The generic safeguards — 0600 modes,
 * guarded writes, the propagation CAS fence — moved here VERBATIM from the
 * daemon's `control/credentials.ts`; they are correct.
 */
import { homedir, platform as currentPlatform, userInfo } from 'node:os'
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import {
  declaredValue,
  resolveCredentialFilePath,
  type CredentialFileLayout,
  type HarnessCredentials,
} from '../manifest.js'
import { AGENT_MANIFESTS } from '../registry.js'
import { FileCredentialStore, MAX_CREDENTIAL_BYTES } from './credential-store.js'
import type { PortableCredentialStore } from '../manifest.js'

export interface PortableCredentialOptions {
  /** Use the credential home itself, never a configured/managed file redirect. */
  realHome?: boolean
  /** Apply propagation-only validity, freshness, and CAS guards. */
  guarded?: boolean
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  osUsername?: string
  /** Resolved CLI versions by harness kind; keys flow as values. */
  versions?: ReadonlyMap<string, string | undefined>
}

function credentialSections(): HarnessCredentials[] {
  const sections: HarnessCredentials[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const section = declaredValue(manifest.credentials)
    if (section) sections.push(section)
  }
  return sections
}

function layoutFor(
  kind: PortableCredentialKind,
): { section: HarnessCredentials; file: CredentialFileLayout } | undefined {
  for (const section of credentialSections()) {
    if (!section.kinds.includes(kind)) continue
    const file = section.files.find((candidate) => candidate.kind === kind)
    if (file) return { section, file }
  }
  return undefined
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
  section: HarnessCredentials,
  file: CredentialFileLayout,
  home: string,
  options: PortableCredentialOptions,
): PortableCredentialStore {
  const absolutePath = resolveCredentialFilePath(file, home, options)
  const transfer = declaredValue(section.transfer)
  const viaTransfer = transfer?.createStore({
    platform: options.platform ?? currentPlatform(),
    home,
    env: options.env ?? process.env,
    osUsername: options.osUsername ?? defaultUsername(),
    versions: options.versions ?? new Map(),
    file,
    fileAbsolutePath: absolutePath,
  })
  return viaTransfer ?? new FileCredentialStore(absolutePath)
}

export async function readPortableCredential(
  kind: PortableCredentialKind,
  home: string,
  options: PortableCredentialOptions = {},
): Promise<PortableCredentialBundle | null> {
  const found = layoutFor(kind)
  if (!found) return null
  const { section, file } = found
  if (options.guarded && !file.propagatable) return null
  const read = await credentialStore(section, file, home, options).read()
  if (read.state === 'absent') return null
  if (read.state === 'unavailable') throw new Error(`credential store unavailable: ${read.reason}`)
  try {
    if (read.contents.length <= 0 || read.contents.length > MAX_CREDENTIAL_BYTES) return null
    const text = read.contents.toString('utf8')
    const parsed = JSON.parse(text) as unknown
    if (options.guarded && !file.validate(text)) return null
    const content =
      file.sanitize && file.mergeInstall
        ? Buffer.from(JSON.stringify(file.sanitize(parsed)))
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
    const found = layoutFor(bundle.kind)
    if (!found) throw new Error('credential propagation only supports native Codex and Claude files')
    const { section, file } = found
    const store = credentialStore(section, file, home, options)
    if (options.guarded) {
      if (!file.propagatable) {
        throw new Error('credential propagation only supports native Codex and Claude files')
      }
      if (!file.validate(text)) {
        throw new Error('credential propagation payload is not a valid native login')
      }
      return await store.guardedInstall(content, {
        valid: (current) => file.validate(current),
        compareFreshness: file.compareFreshness,
      })
    }

    if (!file.mergeInstall) return await store.install(content)
    if (!file.sanitize) throw new Error('credential merge install requires a sanitize projection')
    const portable = file.sanitize(parsed)
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

export interface CredentialRuntimeSnapshot {
  env: Readonly<Record<string, string | undefined>>
  versions: ReadonlyMap<string, string | undefined>
}

export interface CredentialHandlerPorts {
  readonly homeDir?: string
  snapshotRuntime(): Promise<CredentialRuntimeSnapshot | undefined>
  reportInventory(): void | Promise<void>
}

export interface CredentialExportMessage {
  requestId: string
  kinds: readonly PortableCredentialKind[]
  propagation?: boolean
}

export interface CredentialInstallMessage {
  requestId: string
  bundles: readonly PortableCredentialBundle[]
  propagation?: boolean
}

export async function handleCredentialExport(
  ports: CredentialHandlerPorts,
  msg: CredentialExportMessage,
): Promise<{
  type: 'credentialExportResult'
  requestId: string
  bundles: PortableCredentialBundle[]
  unavailable: PortableCredentialKind[]
}> {
  const home = ports.homeDir ?? homedir()
  const runtime = await ports.snapshotRuntime().catch(() => undefined)
  const options: PortableCredentialOptions = {
    platform: currentPlatform(),
    ...(runtime
      ? { env: runtime.env, versions: runtime.versions }
      : { env: process.env, versions: new Map() }),
  }
  const bundles: PortableCredentialBundle[] = []
  const unavailable: PortableCredentialKind[] = []
  for (const kind of msg.kinds) {
    try {
      const bundle = await readPortableCredential(kind, home, {
        ...options,
        realHome: msg.propagation === true,
        guarded: msg.propagation === true,
      })
      if (bundle) bundles.push(bundle)
      else unavailable.push(kind)
    } catch {
      unavailable.push(kind)
    }
  }
  return { type: 'credentialExportResult', requestId: msg.requestId, bundles, unavailable }
}

export async function handleCredentialInstall(
  ports: CredentialHandlerPorts,
  msg: CredentialInstallMessage,
): Promise<{
  type: 'credentialInstallResult'
  requestId: string
  installed: PortableCredentialKind[]
  failed: PortableCredentialKind[]
}> {
  const home = ports.homeDir ?? homedir()
  const runtime = await ports.snapshotRuntime().catch(() => undefined)
  const options: PortableCredentialOptions = {
    platform: currentPlatform(),
    ...(runtime
      ? { env: runtime.env, versions: runtime.versions }
      : { env: process.env, versions: new Map() }),
  }
  const installed: PortableCredentialKind[] = []
  const failed: PortableCredentialKind[] = []
  for (const bundle of msg.bundles) {
    try {
      const didInstall = await installPortableCredential(bundle, home, {
        ...options,
        realHome: msg.propagation === true,
        guarded: msg.propagation === true,
      })
      if (didInstall) installed.push(bundle.kind)
      else failed.push(bundle.kind)
    } catch {
      failed.push(bundle.kind)
    }
  }
  if (installed.length > 0) {
    try {
      await ports.reportInventory()
    } catch {
      // A failed re-probe must not fail the install acknowledgment.
    }
  }
  return { type: 'credentialInstallResult', requestId: msg.requestId, installed, failed }
}
