import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PODIUM_GROK_HOOK_URL_ENV } from '@podium/agent-bridge'

/**
 * Grok Build reads personal hooks from GROK_HOME/hooks without project trust.
 * Podium installs one env-gated command hook per lifecycle event: Podium-spawned
 * sessions inherit their own callback URL; every other Grok process exits 0
 * before touching the network. The command streams the daemon response back to
 * Grok so supported hook responses (additional context / decisions) remain usable.
 */
export const PODIUM_GROK_HOOK_COMMAND = `bash -c 'u="$${PODIUM_GROK_HOOK_URL_ENV}"; [ -n "$u" ] || exit 0; curl -fsS -m 2 -X POST -H "content-type: application/json" --data-binary @- "$u" 2>/dev/null || true'`

const PODIUM_GROK_HOOK_TIMEOUT_SEC = 5
const GROK_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const

interface HookHandler {
  type?: string
  command?: string
  timeout?: number
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks?: HookHandler[]
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPodiumHandler(handler: HookHandler | undefined): boolean {
  return typeof handler?.command === 'string' && handler.command.includes(PODIUM_GROK_HOOK_URL_ENV)
}

function upsertHooks(doc: Record<string, unknown>): {
  doc: Record<string, unknown>
  changed: boolean
} {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  let changed = !isRecord(doc.hooks)

  for (const event of GROK_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    let found = false
    for (const group of groups) {
      const handlers = group.hooks ?? []
      for (let index = 0; index < handlers.length; index++) {
        const handler = handlers[index]
        if (found || !isPodiumHandler(handler)) continue
        found = true
        if (
          handler?.type !== 'command' ||
          handler.command !== PODIUM_GROK_HOOK_COMMAND ||
          handler.timeout !== PODIUM_GROK_HOOK_TIMEOUT_SEC
        ) {
          handlers[index] = {
            type: 'command',
            command: PODIUM_GROK_HOOK_COMMAND,
            timeout: PODIUM_GROK_HOOK_TIMEOUT_SEC,
          }
          changed = true
        }
      }
    }
    if (!found) {
      groups.push({
        hooks: [
          {
            type: 'command',
            command: PODIUM_GROK_HOOK_COMMAND,
            timeout: PODIUM_GROK_HOOK_TIMEOUT_SEC,
          },
        ],
      })
      changed = true
    }
    hooks[event] = groups
  }

  return { doc: { ...doc, hooks }, changed }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.podium-tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/**
 * Install or refresh Podium's dedicated personal Grok hook file. Foreign groups
 * in that file are preserved, corrupt content is never overwritten, and a host
 * without a Grok home is a clean no-op.
 */
export async function ensurePodiumGrokHooks(opts?: {
  homeDir?: string
  grokHome?: string
}): Promise<{ installed: boolean; changed: boolean; reason?: string }> {
  const grokHome =
    opts?.grokHome ??
    (opts?.homeDir
      ? join(opts.homeDir, '.grok')
      : process.env.GROK_HOME?.trim() || join(homedir(), '.grok'))
  if (!existsSync(grokHome)) return { installed: false, changed: false, reason: 'no GROK_HOME' }

  const hooksDir = join(grokHome, 'hooks')
  const hooksPath = join(hooksDir, 'podium.json')
  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksPath, 'utf8'))
    if (!isRecord(parsed)) {
      return { installed: false, changed: false, reason: 'podium hook file is not an object' }
    }
    doc = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { installed: false, changed: false, reason: 'unreadable podium hook file' }
    }
  }

  const upserted = upsertHooks(doc)
  if (upserted.changed) {
    await mkdir(hooksDir, { recursive: true })
    await writeAtomic(hooksPath, `${JSON.stringify(upserted.doc, null, 2)}\n`)
  }
  return { installed: true, changed: upserted.changed }
}
