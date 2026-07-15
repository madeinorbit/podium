import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PODIUM_CODEX_HOOK_URL_ENV } from '@podium/agent-bridge'

/**
 * Install Podium's Codex native-hook instrumentation (Orca-style).
 *
 * Codex ≥0.142 fires Claude-style shell-command hooks (`hooks` feature, stable):
 * `<CODEX_HOME>/hooks.json` declares per-event handlers that receive a JSON
 * payload on stdin carrying session_id + transcript_path + event fields. A hook
 * only RUNS once `config.toml` carries a `[hooks.state."<key>"]` entry whose
 * `trusted_hash` matches the sha256 of the handler's normalized identity —
 * otherwise codex silently drops it. So install = upsert hooks.json + matching
 * trust entries, both idempotent and preserving anything another tool put there.
 *
 * The handler is env-gated fail-open: sessions spawned by Podium carry
 * `PODIUM_CODEX_HOOK_URL` (the per-session ingest endpoint) in their env, which
 * child hook processes inherit; any codex run without the var consumes its hook
 * payload and exits 0, so the global install neither affects sessions Podium
 * didn't spawn nor closes stdin while Codex is still writing it.
 */

// Single-line, POSIX, no dependencies beyond curl. Read stdin BEFORE the env
// gate so Codex never gets EPIPE from an unrouted global hook. Fail-open
// everywhere: no env → exit 0; curl failure swallowed. Bounded (-m 2) so a
// wedged daemon can't stall a codex turn past the hook timeout.
export const PODIUM_CODEX_HOOK_COMMAND = `bash -c 'p=$(cat); u="$${PODIUM_CODEX_HOOK_URL_ENV}"; [ -n "$u" ] || exit 0; printf %s "$p" | curl -fsS -m 2 -X POST -H "content-type: application/json" --data-binary @- "$u" >/dev/null 2>&1 || true'`

const PODIUM_CODEX_HOOK_TIMEOUT_SEC = 5

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const

// config.toml trust keys use the snake_case event label (codex-rs hashes the
// serde snake_case name); hooks.json uses PascalCase.
const EVENT_LABEL: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
}

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

/** Sort object keys recursively so the hash is stable regardless of key order —
 *  mirrors codex-rs's canonical serialization of the hook identity. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * codex-rs command_hook_hash: sha256 over the canonical JSON of the normalized
 * hook identity `{event_name, matcher?, hooks:[{type,command,timeout,async}]}`.
 * timeout normalizes to 600 when absent (min 1), async to false; `matcher` is
 * OMITTED (not null) when absent. Validated bit-exact against codex 0.142.5:
 * hooks trusted this way run without `--dangerously-bypass-hook-trust`.
 */
export function computeCodexTrustedHash(entry: {
  eventLabel: string
  command: string
  timeoutSec?: number
  matcher?: string
}): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command: entry.command,
    timeout: Math.max(1, entry.timeoutSec ?? 600),
    async: false,
  }
  const identity: Record<string, unknown> = {
    event_name: entry.eventLabel,
    hooks: [handler],
  }
  if (entry.matcher !== undefined) identity.matcher = entry.matcher
  const serialized = JSON.stringify(canonicalize(identity))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

/** Codex canonicalizes the hooks.json path in trust keys (macOS /var → /private/var). */
function canonicalTrustPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.podium-tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/**
 * Upsert the Podium handler into hooks.json (parsed structure), preserving all
 * foreign groups/handlers. Returns the (possibly updated) doc, whether it
 * changed, and the (groupIndex, handlerIndex) of the Podium handler per event —
 * the indices the trust keys must reference.
 */
function upsertHooksJson(doc: Record<string, unknown>): {
  doc: Record<string, unknown>
  changed: boolean
  positions: Map<string, { group: number; handler: number }>
} {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  let changed = !isRecord(doc.hooks)
  const positions = new Map<string, { group: number; handler: number }>()
  for (const event of CODEX_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    let found: { group: number; handler: number } | undefined
    groups.forEach((group, g) => {
      group.hooks?.forEach((handler, i) => {
        if (found || !isPodiumHandler(handler)) return
        found = { group: g, handler: i }
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
      found = { group: groups.length - 1, handler: 0 }
      changed = true
    }
    hooks[event] = groups
    positions.set(event, found)
  }
  return { doc: { ...doc, hooks }, changed, positions }
}

/**
 * Upsert `[hooks.state."<key>"]` trust blocks into config.toml TEXTUALLY —
 * the file is the user's (comments, other tools' entries); we only ever touch
 * blocks whose key points at OUR hooks.json path AND whose hash is ours (or
 * whose key we now occupy). Appends missing blocks at EOF (TOML allows table
 * headers in any order).
 */
function upsertTrustEntries(
  content: string,
  wanted: { key: string; hash: string }[],
  hooksJsonPath: string,
): { content: string; changed: boolean } {
  const wantedByKey = new Map(wanted.map((w) => [w.key, w.hash]))
  const wantedHashes = new Set(wanted.map((w) => w.hash))
  const lines = content.split('\n')
  const out: string[] = []
  let changed = false
  const satisfied = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const header = /^\[hooks\.state\."(.+)"\]\s*$/.exec(line)
    if (header) {
      const key = header[1] as string
      const block: string[] = [line]
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j] as string
        if (/^\s*\[/.test(l)) break
        block.push(l)
      }
      const blockText = block.join('\n')
      const isOurPath = key.startsWith(`${hooksJsonPath}:`)
      const hasOurHash = [...wantedHashes].some((h) => blockText.includes(h))
      const want = wantedByKey.get(key)
      if (want) {
        // Key we occupy: rewrite the block to exactly what we need.
        const desired = [`[hooks.state."${key}"]`, 'enabled = true', `trusted_hash = "${want}"`, '']
        if (blockText.trimEnd() !== desired.join('\n').trimEnd()) changed = true
        out.push(...desired)
        satisfied.add(key)
      } else if (isOurPath && hasOurHash) {
        // Stale podium entry from an earlier index layout — drop it.
        changed = true
      } else {
        out.push(...block)
      }
      i = j - 1
      continue
    }
    out.push(line)
  }
  for (const { key, hash } of wanted) {
    if (satisfied.has(key)) continue
    if (out.length > 0 && out[out.length - 1]?.trim() !== '') out.push('')
    out.push(`[hooks.state."${key}"]`, 'enabled = true', `trusted_hash = "${hash}"`, '')
    changed = true
  }
  return { content: out.join('\n'), changed }
}

/**
 * Ensure Podium's codex hooks are installed and trusted. Safe to call on every
 * daemon boot: no-op (no writes) when everything is already in place; never
 * removes or reorders another tool's hooks or trust entries. Skips silently
 * when `<home>/.codex` doesn't exist (codex not installed / not used).
 */
export async function ensurePodiumCodexHooks(opts?: {
  homeDir?: string
}): Promise<{ installed: boolean; changed: boolean; reason?: string }> {
  const codexHome = join(opts?.homeDir ?? homedir(), '.codex')
  if (!existsSync(codexHome)) return { installed: false, changed: false, reason: 'no ~/.codex' }
  const hooksJsonPath = join(codexHome, 'hooks.json')
  const configTomlPath = join(codexHome, 'config.toml')

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

  const canonicalPath = canonicalTrustPath(hooksJsonPath)
  const wanted = CODEX_HOOK_EVENTS.map((event) => {
    const pos = upserted.positions.get(event) as { group: number; handler: number }
    return {
      key: `${canonicalPath}:${EVENT_LABEL[event]}:${pos.group}:${pos.handler}`,
      hash: computeCodexTrustedHash({
        eventLabel: EVENT_LABEL[event],
        command: PODIUM_CODEX_HOOK_COMMAND,
        timeoutSec: PODIUM_CODEX_HOOK_TIMEOUT_SEC,
      }),
    }
  })
  let toml = ''
  try {
    toml = await readFile(configTomlPath, 'utf8')
  } catch {
    // no config.toml yet — created below with just our trust entries
  }
  const trust = upsertTrustEntries(toml, wanted, canonicalPath)
  if (trust.changed) await writeAtomic(configTomlPath, trust.content)
  return { installed: true, changed: upserted.changed || trust.changed }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
