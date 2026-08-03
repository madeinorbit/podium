import type { IssueTrpc } from '@podium/issue-client'
import { ISSUE_COMMANDS, type IssueCommand } from '@podium/issue-client'
import type { ThreadId } from '@podium/model'
import type { z } from 'zod'
import type { McpToolProvider } from './mcp-route'

/** Minimal JSON Schema for the flat z.object arg schemas the registry uses. */
function zodToJsonSchema(schema: z.ZodType): {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
} {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape ?? {}
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, raw] of Object.entries(shape)) {
    let def = raw as z.ZodType
    let optional = false
    // unwrap optional/default/coerce wrappers to the inner type name
    while (def && (def as unknown as { _def?: { typeName?: string } })._def) {
      const tn = (def as unknown as { _def: { typeName: string; innerType?: z.ZodType } })._def
        .typeName
      if (tn === 'ZodOptional' || tn === 'ZodDefault') {
        optional = true
        def = (def as unknown as { _def: { innerType: z.ZodType } })._def.innerType
        continue
      }
      break
    }
    const tn = (def as unknown as { _def: { typeName: string } })._def.typeName
    const jsonType = tn === 'ZodNumber' ? 'number' : tn === 'ZodBoolean' ? 'boolean' : 'string'
    properties[key] = { type: jsonType }
    if (!optional) required.push(key)
  }
  return { type: 'object', properties, required }
}

const toolName = (c: IssueCommand): string => `issue_${c.name.replace(/-/g, '_')}`

/** MCP tools for the native issue tracker, generated from the shared command registry. */
export class IssueToolProvider implements McpToolProvider {
  private client: IssueTrpc | undefined
  private clientForThread: ((threadId: ThreadId) => IssueTrpc) | undefined
  setClient(client: IssueTrpc): void {
    this.client = client
  }
  setClientResolver(resolve: (threadId: ThreadId) => IssueTrpc): void {
    this.clientForThread = resolve
  }
  mcpToolSpecs(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return ISSUE_COMMANDS.map((c) => ({
      name: toolName(c),
      description: c.summary,
      inputSchema: zodToJsonSchema(c.args),
    }))
  }
  async callMcpTool(
    name: string,
    args: Record<string, unknown>,
    threadId?: ThreadId,
  ): Promise<string> {
    const cmd = ISSUE_COMMANDS.find((c) => toolName(c) === name)
    if (!cmd) throw new Error(`unknown issue tool: ${name}`)
    const client = threadId ? (this.clientForThread?.(threadId) ?? this.client) : this.client
    if (!client) throw new Error('issue MCP requires an owned superagent thread')
    const parsed = cmd.args.safeParse(args)
    if (!parsed.success)
      throw new Error(
        `invalid args: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
          .join('; ')}`,
      )
    const res = await cmd.run(client, parsed.data as Record<string, unknown>)
    return res.text
  }
}

/** Fan one MCP surface out over several providers (superagent ⊕ issue tools). */
export class CompositeMcpProvider implements McpToolProvider {
  constructor(private readonly providers: McpToolProvider[]) {}
  mcpToolSpecs(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return this.providers.flatMap((p) => p.mcpToolSpecs())
  }
  async callMcpTool(
    name: string,
    args: Record<string, unknown>,
    threadId?: ThreadId,
  ): Promise<string> {
    const owner = this.providers.find((p) => p.mcpToolSpecs().some((s) => s.name === name))
    if (!owner) throw new Error(`unknown tool: ${name}`)
    return owner.callMcpTool(name, args, threadId)
  }
}
