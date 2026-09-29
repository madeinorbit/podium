// Logs EVERY OpenCode plugin hook (the Hooks interface of @opencode-ai/plugin 1.18.33) with its time.
// It never changes an output. Set HOOK_LOG to the log file.
import { appendFileSync } from 'node:fs'
const LOG = process.env.HOOK_LOG ?? '/dev/null'
const w = (hook: string, input: unknown, output?: unknown) => {
  try {
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), hook, input, output }) + '\n')
  } catch (e) {
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), hook, unserializable: String(e) }) + '\n')
  }
}
const brief = (msgs: any[]) => msgs.map((m) => ({ id: m.info?.id, role: m.info?.role, parts: (m.parts ?? []).map((p: any) => ({ id: p.id, type: p.type, text: typeof p.text === 'string' ? p.text.slice(0, 200) : undefined, synthetic: p.synthetic })) }))
export const HookLog = async (ctx: any) => {
  w('plugin.init', { directory: ctx?.directory, worktree: ctx?.worktree })
  return {
    dispose: async () => w('dispose', {}),
    event: async (input: any) => w('event', { type: input?.event?.type, properties: input?.event?.properties }),
    config: async (input: any) => w('config', { model: input?.model }),
    'chat.message': async (input: any, output: any) => w('chat.message', input, output),
    'chat.params': async (input: any, output: any) => w('chat.params', { sessionID: input.sessionID, agent: input.agent, model: input.model?.id, messageID: input.message?.id }, { temperature: output.temperature }),
    'chat.headers': async (input: any, _output: any) => w('chat.headers', { sessionID: input.sessionID, agent: input.agent, messageID: input.message?.id }),
    'permission.ask': async (input: any, output: any) => w('permission.ask', input, output),
    'command.execute.before': async (input: any, output: any) => w('command.execute.before', input, output),
    'tool.execute.before': async (input: any, output: any) => w('tool.execute.before', input, output),
    'shell.env': async (input: any, _output: any) => w('shell.env', input),
    'tool.execute.after': async (input: any, output: any) => w('tool.execute.after', input, { title: output?.title, output: String(output?.output ?? '').slice(0, 200) }),
    'experimental.chat.messages.transform': async (_input: any, output: any) => w('experimental.chat.messages.transform', {}, { messages: brief(output?.messages ?? []) }),
    'experimental.chat.system.transform': async (input: any, _output: any) => w('experimental.chat.system.transform', { sessionID: input?.sessionID }),
    'experimental.provider.small_model': async (input: any, _output: any) => w('experimental.provider.small_model', { provider: input?.provider?.id }),
    'experimental.session.compacting': async (input: any, _output: any) => w('experimental.session.compacting', input),
    'experimental.compaction.autocontinue': async (input: any, output: any) => w('experimental.compaction.autocontinue', { sessionID: input?.sessionID, messageID: input?.message?.id, overflow: input?.overflow }, output),
    'experimental.text.complete': async (input: any, output: any) => w('experimental.text.complete', input, output),
    'tool.definition': async (input: any, _output: any) => w('tool.definition', input),
  }
}
