import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PODIUM_CODEX_HOOK_SOCKET_ENV, PODIUM_CODEX_HOOK_URL_ENV } from '@podium/harness'

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

/** Versions whose public hooks.json contract was exercised by Podium. */
const SUPPORTED_CODEX_MINOR = { min: 142, max: 146 } as const

export interface CodexVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

export interface CodexHookDiagnostic {
  code: 'codex-version-unsupported'
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
  return (
    version.major === 0 &&
    version.minor >= SUPPORTED_CODEX_MINOR.min &&
    version.minor <= SUPPORTED_CODEX_MINOR.max
  )
}

export async function detectCodexVersion(): Promise<string> {
  const { stdout, stderr } = await execFileAsync('codex', ['--version'], { timeout: 10_000 })
  return `${stdout}${stderr}`.trim()
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
 * Ensure Podium's codex hook definitions are installed. Safe to call on every
 * daemon boot: no-op (no writes) when everything is already in place; never
 * removes or reorders another tool's hooks. Skips silently when
 * `<home>/.codex` doesn't exist (codex not installed / not used).
 */
export async function ensurePodiumCodexHooks(opts?: {
  homeDir?: string
  versionProbe?: CodexVersionProbe
  onDegraded?: (diagnostic: CodexHookDiagnostic) => void
}): Promise<{ installed: boolean; changed: boolean; degraded?: boolean; reason?: string }> {
  const codexHome = join(opts?.homeDir ?? homedir(), '.codex')
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
    console.error(`[podium:daemon] ${diagnostic.title.toUpperCase()}: ${diagnostic.body}`)
    opts?.onDegraded?.(diagnostic)
    return {
      installed: false,
      changed: false,
      degraded: true,
      reason: 'unsupported codex version',
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

  return { installed: true, changed: upserted.changed }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
