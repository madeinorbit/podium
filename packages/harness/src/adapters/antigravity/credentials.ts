import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type HostTools, hostTools } from '../../host-tools.js'
import {
  type HarnessCredentials,
  type HarnessEnvironment,
  MAX_CREDENTIAL_BYTES,
  unsupported,
} from '../../manifest.js'
import { isRecord, stringField } from '../shared/json-util.js'
import { fingerprintForLoginIdentity } from '../shared/login-identity.js'
import { ANTIGRAVITY_HOME, ANTIGRAVITY_TOKEN, antigravityRoots } from './paths.js'

// go-keyring uses a generic Windows credential named service:username. Read
// its UTF-8 blob through CredReadW; no password appears on the command line.
const WINDOWS_KEYRING_READ = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PodiumGoogleCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential { public uint Flags, Type; public string TargetName, Comment; public long LastWritten; public uint Size; public IntPtr Blob; public uint Persist, AttributeCount; public IntPtr Attributes; public string Alias, UserName; }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, uint type, uint flags, out IntPtr pointer);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr pointer);
}
'@
$credentialPointer = [IntPtr]::Zero
if ([PodiumGoogleCredential]::Read('gemini:antigravity', 1, 0, [ref]$credentialPointer)) {
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][PodiumGoogleCredential+Credential])
    if ($credential.Size -gt 1000000) { exit 1 }
    $credentialBytes = New-Object byte[] $credential.Size
    [Runtime.InteropServices.Marshal]::Copy($credential.Blob, $credentialBytes, 0, $credential.Size)
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    [Console]::Write([Text.Encoding]::UTF8.GetString($credentialBytes))
    [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
  } finally { [PodiumGoogleCredential]::CredFree($credentialPointer) }
} else { exit 1 }
`

export function parseAntigravityCredential(contents: string): Record<string, unknown> | undefined {
  try {
    // go-keyring's macOS security-tool backend encodes its stored value.
    const text = contents.startsWith('go-keyring-base64:')
      ? Buffer.from(contents.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
      : contents
    const raw: unknown = JSON.parse(text)
    return isRecord(raw) && isRecord(raw.token) ? raw : undefined
  } catch {
    return undefined
  }
}

export function hasValidAntigravityCredential(contents: string, now = Date.now()): boolean {
  const record = parseAntigravityCredential(contents)
  const token = record?.token
  if (!isRecord(token)) return false
  if (stringField(token, 'refresh_token')) return true
  const expires = typeof token.expiry === 'string' ? Date.parse(token.expiry) : NaN
  return !!stringField(token, 'access_token') && Number.isFinite(expires) && expires > now
}

export function antigravityCredentialIdentity(contents: string) {
  const record = parseAntigravityCredential(contents)
  if (!record || !isRecord(record.token) || !hasValidAntigravityCredential(contents))
    return undefined
  const token = record.token
  let claims: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(
        String(record.id_token ?? token.id_token).split('.')[1] ?? '',
        'base64url',
      ).toString(),
    )
    if (isRecord(parsed)) claims = parsed
  } catch {
    /* Google access tokens are usually opaque. */
  }
  const user = isRecord(record.user_info) ? record.user_info : {}
  const email =
    stringField(record, 'email') ?? stringField(user, 'email') ?? stringField(claims, 'email')
  const providerAccountId = stringField(claims, 'sub') ?? email
  // Refresh lineage is stable when Google's stored profile has no identity
  // claims. Never use the rotating access token to identify a refreshable login.
  const lineage =
    providerAccountId ?? stringField(token, 'refresh_token') ?? stringField(token, 'access_token')
  if (!lineage) return undefined
  const project = stringField(record, 'project_id') ?? stringField(record, 'quota_project_id') ?? ''
  return {
    fingerprint: fingerprintForLoginIdentity(`google:${lineage}:${project}`),
    ...(email ? { email } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
  }
}

/** Read the CLI's native store. Native tokens stay on this machine, and only
 * identity fingerprints escape this module. Isolated homes never read the keyring. */
export function readAntigravityCredential(
  home: string,
  env: HarnessEnvironment,
  tools: HostTools = hostTools(env),
): string | undefined {
  const file = join(antigravityRoots(home, env).credentials, ANTIGRAVITY_TOKEN)
  const readFile = () => {
    try {
      return statSync(file).size <= MAX_CREDENTIAL_BYTES ? readFileSync(file, 'utf8') : undefined
    } catch {
      return undefined
    }
  }
  if (env[ANTIGRAVITY_HOME] || env.SSH_CONNECTION || env.SSH_TTY) return readFile()
  let credential: string | undefined
  try {
    const options = {
      env: { ...env },
      timeout: 5_000,
      maxBuffer: MAX_CREDENTIAL_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    }
    if (process.platform === 'darwin')
      credential = tools.execFileSync(
        'security',
        ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        options,
      )
    else if (process.platform === 'linux')
      credential = tools.execFileSync(
        'secret-tool',
        ['lookup', 'service', 'gemini', 'username', 'antigravity'],
        options,
      )
    else if (process.platform === 'win32')
      credential = tools.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(WINDOWS_KEYRING_READ, 'utf16le').toString('base64'),
        ],
        options,
      )
    const raw = credential?.trim()
    return raw && hasValidAntigravityCredential(raw) ? raw : readFile()
  } catch {
    return readFile()
  }
}

export const antigravityCredentials: HarnessCredentials = {
  kinds: ['antigravity'],
  files: [
    {
      kind: 'antigravity',
      dirName: '.gemini',
      fileName: ANTIGRAVITY_TOKEN,
      homeEnvVar: ANTIGRAVITY_HOME,
      propagatable: false,
      validate: hasValidAntigravityCredential,
      freshness: (contents) => {
        const record = parseAntigravityCredential(contents)
        const token = record?.token
        const value =
          isRecord(token) && typeof token.expiry === 'string' ? Date.parse(token.expiry) : NaN
        return Number.isFinite(value) ? value : undefined
      },
      compareFreshness: () => null,
    },
  ],
  identity: (read) => {
    const raw = read('.gemini', ANTIGRAVITY_TOKEN)
    return raw ? antigravityCredentialIdentity(raw) : undefined
  },
  transfer: unsupported(
    'Google subscription homes use native remote sign-in; automatic copying of OS-keyring credentials is not supported',
  ),
}
