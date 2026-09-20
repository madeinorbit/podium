import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  AGENT_VERSION_PROBE_TIMEOUT_MS,
  PODIUM_CODEX_HOOK_SOCKET_ENV,
  PODIUM_CODEX_HOOK_URL_ENV,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import { reportHarnessProbe } from './harness-version-reporting'

const log = createLogger('daemon:codex-hooks')

/**
 * Install Podium's Codex native-hook instrumentation (Orca-style).
 *
 * Codex ≥0.142 fires Claude-style shell-command hooks (`hooks` feature, stable):
 * `<CODEX_HOME>/hooks.json` declares per-event handlers that receive a JSON
 * payload on stdin carrying session_id + transcript_path + event fields. Podium
 * installs the definition but deliberately leaves review/trust to Codex's public
 * `/hooks` flow. It never writes Codex's private trust-state representation.
 * The process-owned rollout fallback supplies the same exact binding observation.
 *
 * The handler is env-gated fail-open: sessions spawned by Podium carry an
 * instance-scoped socket in their env, which child hook
 * processes inherit. Any Codex run without Podium's env consumes stdin and exits
 * 0, so the global install does not affect non-Podium sessions.
 */

// Single-line POSIX handler. It posts over the stable Unix socket; the daemon
// durably records exact identity in SessionBinding before acknowledging HTTP.
// URL is a one-release fallback for processes running an older hook command.
// Read stdin before every env gate so Codex never sees EPIPE; every I/O failure
// remains fail-open and curl is bounded to two seconds.
export const PODIUM_CODEX_HOOK_COMMAND = `bash -c 'p=$(cat); sid="$PODIUM_SESSION_ID"; s="$${PODIUM_CODEX_HOOK_SOCKET_ENV}"; u="$${PODIUM_CODEX_HOOK_URL_ENV}"; if [ -n "$s" ] && [ -n "$sid" ]; then printf %s "$p" | curl -fsS -m 2 --unix-socket "$s" -X POST -H "content-type: application/json" --data-binary @- "http://localhost/hooks/$sid" >/dev/null 2>&1 || true; elif [ -n "$u" ]; then printf %s "$p" | curl -fsS -m 2 -X POST -H "content-type: application/json" --data-binary @- "$u" >/dev/null 2>&1 || true; fi'`

const PODIUM_CODEX_HOOK_TIMEOUT_SEC = 5
const execFileAsync = promisify(execFile)

/**
 * The first Codex whose public hooks.json contract Podium exercised. A FLOOR
 * ONLY: a newer Codex has already been installed by the user, so refusing it
 * leaves them nothing to do, and the hooks.json format has stayed additive
 * across every minor since. Newer versions install and run; a break would
 * surface as missing observations, never as a refused session (POD-4083).
 */
const MINIMUM_CODEX_HOOKS_MINOR = 142

export interface CodexVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

export interface CodexHookDiagnostic {
  code: 'codex-version-unsupported' | 'codex-hooks-untrusted'
  title: 'Codex hooks need review'
  body: string
  observedVersion: string
}

export type CodexVersionProbe = () => Promise<string>

export function parseCodexVersion(output: string): CodexVersion | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim())
  if (!match) return null
  return {
    raw: output.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function supportsCodexHooks(version: CodexVersion): boolean {
  if (version.major !== 0) return version.major > 0
  return version.minor >= MINIMUM_CODEX_HOOKS_MINOR
}

export async function detectCodexVersion(): Promise<string> {
  const { stdout, stderr } = await execFileAsync('codex', ['--version'], {
    timeout: AGENT_VERSION_PROBE_TIMEOUT_MS,
  })
  const output = `${stdout}${stderr}`.trim()
  reportHarnessProbe('codex', output)
  return output
}

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const

interface HookHandler {
  type?: string
  command?: string
  timeout?: number
  async?: boolean
  [k: string]: unknown
}
interface HookGroup {
  matcher?: string
  hooks?: HookHandler[]
  [k: string]: unknown
}

function isPodiumHandler(h: HookHandler | undefined): boolean {
  return typeof h?.command === 'string' && h.command.includes(PODIUM_CODEX_HOOK_URL_ENV)
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.podium-tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/**
 * Upsert the Podium handler into hooks.json (parsed structure), preserving all
 * foreign groups/handlers.
 */
function upsertHooksJson(doc: Record<string, unknown>): {
  doc: Record<string, unknown>
  changed: boolean
} {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  let changed = !isRecord(doc.hooks)
  for (const event of CODEX_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    let found = false
    groups.forEach((group) => {
      const groupHooks = group.hooks
      groupHooks?.forEach((handler, i) => {
        if (found || !isPodiumHandler(handler)) return
        found = true
        // Refresh a stale podium handler in place (old command/timeout).
        if (
          handler.command !== PODIUM_CODEX_HOOK_COMMAND ||
          handler.timeout !== PODIUM_CODEX_HOOK_TIMEOUT_SEC ||
          handler.type !== 'command'
        ) {
          groupHooks[i] = {
            type: 'command',
            command: PODIUM_CODEX_HOOK_COMMAND,
            timeout: PODIUM_CODEX_HOOK_TIMEOUT_SEC,
          }
          changed = true
        }
      })
    })
    if (!found) {
      groups.push({
        hooks: [
          {
            type: 'command',
            command: PODIUM_CODEX_HOOK_COMMAND,
            timeout: PODIUM_CODEX_HOOK_TIMEOUT_SEC,
          },
        ],
      })
      changed = true
    }
    hooks[event] = groups
  }
  return { doc: { ...doc, hooks }, changed }
}

/**
 * DECISION RECORD (POD-4076): Podium detects Codex hook trust but never grants
 * it. Two alternatives were rejected:
 *
 * - Writing `[hooks.state]` trust entries ourselves would mark our own hooks
 *   trusted on the user's machine, defeating a security control the user owns.
 *   The existing design note ("never writes Codex's private trust-state
 *   representation") stands.
 * - Passing `--dangerously-bypass-hook-trust` at launch is global to the
 *   invocation: it would also run any USER or PROJECT hook configured in that
 *   CODEX_HOME without their trust review. Podium vets only the handlers it
 *   wrote, so a global bypass over-trusts.
 *
 * What remains is detect-and-tell: read the trust state to DIAGNOSE (reading
 * is not writing), and raise an operator diagnostic naming Codex's public
 * `/hooks` flow as the remedy. Until trust exists Codex silently runs none of
 * the handlers, so sessions are poll-only and PermissionRequest — which only
 * the hook channel carries — is gone entirely.
 */

const CODEX_EVENT_SNAKE: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
}

export interface PodiumHookPosition {
  event: string
  snake: string
  group: number
  handler: number
}

/** Locate every Podium handler in a parsed hooks.json doc. */
export function podiumHookPositions(doc: Record<string, unknown>): PodiumHookPosition[] {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  const positions: PodiumHookPosition[] = []
  for (const event of CODEX_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    groups.forEach((group, groupIndex) => {
      const handlers = group?.hooks
      if (!Array.isArray(handlers)) return
      handlers.forEach((handler, handlerIndex) => {
        if (!isPodiumHandler(handler as HookHandler)) return
        // First Podium handler per event is the one Podium maintains; foreign
        // duplicates of the marker are not ours to trust-check. upsert keeps a
        // single Podium handler per event, so any second match is foreign.
        if (positions.some((p) => p.event === event)) return
        positions.push({
          event,
          snake: CODEX_EVENT_SNAKE[event],
          group: groupIndex,
          handler: handlerIndex,
        })
      })
    })
  }
  return positions
}

export interface CodexHookTrustEntry {
  trustedHash?: string
  enabled?: boolean
}

/**
 * Parse Codex's `[hooks.state."<path>:<event>:<i>:<j>"]` trust table without a
 * TOML dependency: scan section headers and pick `trusted_hash` / `enabled`
 * out of each section body. Anything unparseable yields no entry, which reads
 * as untrusted (fail-loud) rather than trusted.
 */
export function parseCodexHookTrustState(configText: string): Map<string, CodexHookTrustEntry> {
  const entries = new Map<string, CodexHookTrustEntry>()
  const headerPattern = /^\s*\[hooks\.state\."([^"]+)"\s*\]\s*$/gim
  const headers: Array<{ key: string; start: number; bodyStart: number }> = []
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(configText)) !== null) {
    headers.push({
      key: match[1] ?? '',
      start: match.index,
      bodyStart: match.index + match[0].length,
    })
  }
  headers.forEach((header, index) => {
    const bodyEnd = index + 1 < headers.length ? (headers[index + 1]?.start ?? configText.length) : configText.length
    const body = configText.slice(header.bodyStart, bodyEnd)
    const hashMatch = /^\s*trusted_hash\s*=\s*"([^"]*)"/im.exec(body)
    const enabledMatch = /^\s*enabled\s*=\s*(true|false)/im.exec(body)
    entries.set(header.key, {
      ...(hashMatch?.[1] ? { trustedHash: hashMatch[1] } : {}),
      ...(enabledMatch?.[1] ? { enabled: enabledMatch[1] === 'true' } : {}),
    })
  })
  return entries
}

/**
 * Check whether Codex will actually run the Podium handlers in `doc`.
 *
 * A handler counts as trusted when its trust entry carries a non-empty
 * `trusted_hash` and is not explicitly `enabled = false`. A missing `enabled`
 * line still counts as trusted: entries written before Codex added the field
 * carry only the hash (observed on live hosts), and Codex runs those hooks.
 */
export function checkPodiumHookTrust(input: {
  hooksJsonPath: string
  doc: Record<string, unknown>
  configText: string | undefined
}): { trusted: boolean; untrusted: string[] } {
  const positions = podiumHookPositions(input.doc)
  if (positions.length === 0) return { trusted: true, untrusted: [] }
  const entries = input.configText ? parseCodexHookTrustState(input.configText) : new Map()
  const untrusted: string[] = []
  for (const position of positions) {
    const key = `${input.hooksJsonPath}:${position.snake}:${position.group}:${position.handler}`
    const entry = entries.get(key)
    if (!entry?.trustedHash || entry.enabled === false) untrusted.push(position.event)
  }
  return { trusted: untrusted.length === 0, untrusted }
}

/**
 * Ensure Podium's codex hook definitions are installed. Safe to call on every
 * daemon boot: no-op (no writes) when everything is already in place; never
 * removes or reorders another tool's hooks. Skips silently when
 * `<home>/.codex` doesn't exist (codex not installed / not used).
 */
export async function ensurePodiumCodexHooks(opts?: {
  homeDir?: string
  codexHome?: string
  versionProbe?: CodexVersionProbe
  onDegraded?: (diagnostic: CodexHookDiagnostic) => void
}): Promise<{
  installed: boolean
  changed: boolean
  degraded?: boolean
  reason?: string
  trusted?: boolean
  untrustedEvents?: string[]
}> {
  const codexHome = opts?.codexHome ?? join(opts?.homeDir ?? homedir(), '.codex')
  if (!existsSync(codexHome)) return { installed: false, changed: false, reason: 'no ~/.codex' }
  const hooksJsonPath = join(codexHome, 'hooks.json')

  let observedVersion: string
  try {
    observedVersion = await (opts?.versionProbe ?? detectCodexVersion)()
  } catch (error) {
    observedVersion = `unavailable (${error instanceof Error ? error.message : String(error)})`
  }
  const parsedVersion = parseCodexVersion(observedVersion)
  if (!parsedVersion || !supportsCodexHooks(parsedVersion)) {
    const diagnostic: CodexHookDiagnostic = {
      code: 'codex-version-unsupported',
      title: 'Codex hooks need review',
      observedVersion,
      body: `Podium does not recognize Codex version '${observedVersion}'. Codex hook automation is disabled; hooks.json and config.toml were left untouched.`,
    }
    // The local banner covers an operator watching the daemon journal. The
    // callback crosses the authenticated machine transport so the server can
    // issue-mail only this machine's owner and admins, never every client.
    log.error(diagnostic.title, {
      code: diagnostic.code,
      observedVersion,
      detail: diagnostic.body,
    })
    opts?.onDegraded?.(diagnostic)
    return {
      installed: false,
      changed: false,
      degraded: true,
      reason: `unsupported codex version: ${observedVersion}`,
    }
  }

  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksJsonPath, 'utf8'))
    if (isRecord(parsed)) doc = parsed
    else return { installed: false, changed: false, reason: 'hooks.json not an object' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unreadable/corrupt hooks.json: leave the user's file alone.
      return { installed: false, changed: false, reason: 'unreadable hooks.json' }
    }
  }
  const upserted = upsertHooksJson(doc)
  if (upserted.changed) {
    await mkdir(codexHome, { recursive: true })
    await writeAtomic(hooksJsonPath, `${JSON.stringify(upserted.doc, null, 2)}\n`)
  }

  // Trust is a separate question from installation: the file above can be
  // in place while Codex silently runs none of it. Read (never write)
  // config.toml's [hooks.state] table and say so when our handlers lack it.
  let configText: string | undefined
  try {
    configText = await readFile(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    configText = undefined
  }
  const trust = checkPodiumHookTrust({
    hooksJsonPath,
    doc: upserted.doc,
    configText,
  })
  if (!trust.trusted) {
    const missing = trust.untrusted.join(', ')
    const diagnostic: CodexHookDiagnostic = {
      code: 'codex-hooks-untrusted',
      title: 'Codex hooks need review',
      observedVersion,
      body: `Podium installed Codex hook handlers in '${hooksJsonPath}' but Codex has not trusted them (missing trust for: ${missing}). Approve them in Codex's own /hooks flow; Podium never marks hooks trusted on your behalf. Until then Codex runs none of Podium's hooks and says nothing about it: sessions fall back to poll-only state and PermissionRequest observations are missing.`,
    }
    log.error(diagnostic.title, {
      code: diagnostic.code,
      observedVersion,
      detail: diagnostic.body,
    })
    opts?.onDegraded?.(diagnostic)
    return {
      installed: true,
      changed: upserted.changed,
      degraded: true,
      reason: `untrusted codex hooks (missing trust for: ${missing}); approve in Codex /hooks`,
      trusted: false,
      untrustedEvents: trust.untrusted,
    }
  }

  return { installed: true, changed: upserted.changed, trusted: true, untrustedEvents: [] }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
