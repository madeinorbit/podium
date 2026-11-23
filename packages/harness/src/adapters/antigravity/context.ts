import { join } from 'node:path'
import type { LaunchFile } from '../../manifest.js'
import { isRecord } from '../shared/json-util.js'

/** Additional workspaces participate in native rules, hooks and MCP discovery.
 * Measured with a session-only workspace and the real CLI; no global edits. */
export function antigravityContext(
  runtimeDir: string | undefined,
  instructions?: string,
  mcpConfig?: string,
) {
  if (!instructions?.trim() && !mcpConfig)
    return { args: [] as string[], files: [] as LaunchFile[] }
  if (!runtimeDir)
    throw new Error('Antigravity needs a session runtime directory for instructions and MCP')
  const root = join(runtimeDir, 'antigravity-context')
  const files: LaunchFile[] = []
  if (instructions?.trim()) files.push({ path: join(root, 'AGENTS.md'), contents: instructions })
  if (mcpConfig) {
    const parsed: unknown = JSON.parse(mcpConfig)
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers))
      throw new Error('Antigravity MCP config requires mcpServers')
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      if (!isRecord(server)) throw new Error(`Invalid MCP server ${name}`)
    }
    files.push({ path: join(root, '.agents', 'mcp_config.json'), contents: JSON.stringify(parsed) })
  }
  return { args: ['--add-dir', root], files }
}
