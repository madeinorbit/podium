import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  PODIUM_CODEX_HOOK_RECEIPT_DIR_ENV,
  PODIUM_CODEX_HOOK_SOCKET_ENV,
  PODIUM_CODEX_HOOK_URL_ENV,
} from '@podium/agent-bridge'

/**
 * Install Podium's Codex native-hook instrumentation (Orca-style).
 *
 * Codex ≥0.142 fires Claude-style shell-command hooks (`hooks` feature, stable):
 * `<CODEX_HOME>/hooks.json` declares per-event handlers that receive a JSON
 * payload on stdin carrying session_id + transcript_path + event fields. Podium
 * installs the definition but deliberately leaves review/trust to Codex's public
 * `/hooks` flow. It never writes Codex's private trust-state representation.
 * The process-owned rollout fallback preserves exact identity until approved.
 *
 * The handler is env-gated fail-open: sessions spawned by Podium carry an
 * instance-scoped socket and receipt directory in their env, which child hook
 * processes inherit. Any Codex run without Podium's env consumes stdin and exits
 * 0, so the global install does not affect non-Podium sessions.
 */

// Single-line POSIX handler. It first replaces this pane's owner-only receipt
// with the latest official Codex payload, then posts over the stable Unix socket.
// The receipt is removed only after the server acknowledges durable persistence.
// URL is a one-release fallback for processes running an older hook command.
// Read stdin before every env gate so Codex never sees EPIPE; every I/O failure
// remains fail-open and curl is bounded to two seconds.
export const PODIUM_CODEX_HOOK_COMMAND = `bash -c 'p=$(cat); sid="$PODIUM_SESSION_ID"; d="$${PODIUM_CODEX_HOOK_RECEIPT_DIR_ENV}"; s="$${PODIUM_CODEX_HOOK_SOCKET_ENV}"; u="$${PODIUM_CODEX_HOOK_URL_ENV}"; if [ -n "$sid" ] && [ -n "$d" ]; then umask 077; mkdir -p "$d" >/dev/null 2>&1 || true; t="$d/$sid.$$.tmp"; if printf %s "$p" >"$t" 2>/dev/null; then mv -f "$t" "$d/$sid.json" 2>/dev/null || rm -f "$t"; fi; fi; if [ -n "$s" ] && [ -n "$sid" ]; then printf %s "$p" | curl -fsS -m 2 --unix-socket "$s" -X POST -H "content-type: application/json" --data-binary @- "http://localhost/hooks/$sid" >/dev/null 2>&1 || true; elif [ -n "$u" ]; then printf %s "$p" | curl -fsS -m 2 -X POST -H "content-type: application/json" --data-binary @- "$u" >/dev/null 2>&1 || true; fi'`

const PODIUM_CODEX_HOOK_TIMEOUT_SEC = 5

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
      group.hooks?.forEach((handler, i) => {
        if (found || !isPodiumHandler(handler)) return
        found = true
        // Refresh a stale podium handler in place (old command/timeout).
        if (
          handler.command !== PODIUM_CODEX_HOOK_COMMAND ||
          handler.timeout !== PODIUM_CODEX_HOOK_TIMEOUT_SEC ||
          handler.type !== 'command'
        ) {
          group.hooks![i] = {
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
}): Promise<{ installed: boolean; changed: boolean; reason?: string }> {
  const codexHome = join(opts?.homeDir ?? homedir(), '.codex')
  if (!existsSync(codexHome)) return { installed: false, changed: false, reason: 'no ~/.codex' }
  const hooksJsonPath = join(codexHome, 'hooks.json')

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
