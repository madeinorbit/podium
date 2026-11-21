/** Launch-only status bridge. No shared settings are ever written. */
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { InstrumentationDestination } from '../../manifest.js'
import { claudeContextVersion, object } from './context-native.js'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The command's stdin is a byte-preserving file (shell substitutions strip
 * trailing newlines). Only the user's command writes stdout/stderr; curl has
 * a hard bound, drains its response privately and cannot change exit status.
 * Every invocation owns its temp directory and removes it on exit/signals. */
export function claudeStatusBridgeCommand(endpoint: string, original?: string): string {
  // Native default is Bash. Evaluate inside its inherited shell rather than
  // starting sh (which loses Bash syntax) or sourcing BASH_ENV a second time.
  const run = original ? `eval ${quote(original)}` : ':'
  const script = [
    `podium_status_dir=$(mktemp -d "\${TMPDIR:-/tmp}/podium-status.XXXXXX") || { ${run}; exit $?; }`,
    `trap 'rm -rf "$podium_status_dir"' EXIT`,
    `trap 'exit 130' INT`,
    `trap 'exit 143' HUP TERM`,
    `cat > "$podium_status_dir/input"`,
    `curl -fsS --max-time 1 --connect-timeout 1 -X POST -H 'content-type: application/json' --data-binary @"$podium_status_dir/input" ${quote(endpoint)} >/dev/null 2>&1 || :`,
    `( ${run} ) < "$podium_status_dir/input"`,
    `exit $?`,
  ].join('\n')
  return script
}

async function settings(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    const value = object(raw)
    if (!value) throw new Error('not an object')
    return value
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return undefined
    throw new Error('Inherited Claude settings could not be safely resolved')
  }
}

/** Native 2.1.319 user → launch-cwd project → local precedence. Local settings
 * canonicalize to the git root only when directory ownership is verified;
 * root local settings override a legacy launch-cwd local file. Managed policy is
 * higher priority than --settings, so it can refuse the bridge without losing
 * its original status line. Never copy hooks or unrelated settings here. */
export async function inheritedClaudeStatusLine(
  configRoot: string,
  workdir: string,
  home?: string,
): Promise<Record<string, unknown> | undefined> {
  const cwd = await realpath(workdir)
  let root = cwd
  let cursor = root
  while (true) {
    try {
      await stat(join(cursor, '.git'))
      root = cursor
      break
    } catch (error) {
      if (object(error)?.code !== 'ENOENT')
        throw new Error('Claude project settings root could not be resolved')
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const uid = process.geteuid?.() ?? process.getuid?.()
  if (root !== cwd) {
    const owner = await stat(root)
    const git = await lstat(join(root, '.git'))
    let claudeUid: number | undefined
    try {
      claudeUid = (await lstat(join(root, '.claude'))).uid
    } catch (error) {
      if (object(error)?.code !== 'ENOENT') throw error
    }
    const homeRoot = home ? await realpath(home).catch(() => resolve(home)) : undefined
    if (
      uid === undefined ||
      owner.uid !== uid ||
      git.uid !== uid ||
      (claudeUid !== undefined && claudeUid !== uid) ||
      root === homeRoot
    )
      root = cwd
  }
  const files = [
    join(configRoot, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    ...(root !== cwd ? [join(cwd, '.claude', 'settings.local.json')] : []),
    join(root, '.claude', 'settings.local.json'),
  ]
  let status: Record<string, unknown> | undefined
  for (const path of files) {
    const value = await settings(path)
    if (!value || !('statusLine' in value)) continue
    const next = object(value.statusLine)
    // Native 2.1.319 validates each source before merging, so a partial
    // command object cannot borrow type/command from a lower-priority file.
    if (!next || next.type !== 'command' || typeof next.command !== 'string')
      throw new Error('Inherited Claude status line has an unsupported shape')
    if (next.args !== undefined || next.shell !== undefined)
      throw new Error('Inherited Claude status command extensions are unverified')
    if (
      next.padding !== undefined &&
      (typeof next.padding !== 'number' || !Number.isFinite(next.padding))
    )
      throw new Error('Inherited Claude status padding is malformed')
    if (next.hideVimModeIndicator !== undefined && typeof next.hideVimModeIndicator !== 'boolean')
      throw new Error('Inherited Claude status options are malformed')
    const refresh =
      typeof next.refreshInterval === 'number' &&
      Number.isFinite(next.refreshInterval) &&
      next.refreshInterval >= 1
        ? next.refreshInterval
        : undefined
    status = {
      ...status,
      type: 'command',
      command: next.command,
      ...(next.padding !== undefined ? { padding: next.padding } : {}),
      ...(next.hideVimModeIndicator !== undefined
        ? { hideVimModeIndicator: next.hideVimModeIndicator }
        : {}),
      ...(refresh !== undefined ? { refreshInterval: refresh } : {}),
    }
  }
  if (status && (status.type !== 'command' || typeof status.command !== 'string'))
    throw new Error('Inherited Claude status command cannot be preserved')
  return status
}

export async function claudeStatusLineOverlay(
  destination: InstrumentationDestination,
): Promise<{ statusLine?: Record<string, unknown>; reason?: string }> {
  if (!destination.workdir) return {}
  const env = destination.harnessContext.env
  if (env.CLAUDE_CODE_USE_COWORK_PLUGINS || env.GIT_DIR || env.GIT_WORK_TREE)
    return {
      reason:
        'Claude context status settings scope is unverified for this environment; existing status line preserved',
    }
  if (process.platform === 'win32')
    return {
      reason:
        'Claude context status bridge is unverified on Windows; existing status line preserved',
    }
  if (!claudeContextVersion(destination.harnessContext.installation.version))
    return {
      reason:
        'Claude context status bridge requires measured 2.1.319-or-later status fields; existing status line preserved',
    }
  const root = destination.harnessContext.roots.config
  if (!root)
    return {
      reason:
        'Claude context status bridge has no pinned settings root; existing status line preserved',
    }
  try {
    const original = await inheritedClaudeStatusLine(
      root,
      destination.workdir,
      destination.harnessContext.home,
    )
    const originalCommand = original?.command as string | undefined
    return {
      statusLine: {
        ...original,
        type: 'command',
        command: claudeStatusBridgeCommand(destination.endpointUrl, originalCommand),
      },
    }
  } catch {
    return {
      reason:
        'Claude context status bridge could not preserve inherited settings; existing status line preserved',
    }
  }
}
