import { harnessCommand } from '../../bound-command.js'
import type { HarnessHeadless } from '../../manifest.js'
import { executeMetadataQuery } from '../../metadata-query.js'
import { noAgentTerms } from '../../posture.js'

type SelectionInput = Parameters<NonNullable<HarnessHeadless['resolveSelection']>>[0]
type PiState = { model?: { provider: string; id: string }; thinkingLevel?: string }

/** A fresh, unsaved RPC session resolves Pi's own defaults, without a prompt.
 *  Omitting flags on the resumed conversation would retain its previous picks. */
async function readPiDefaults(input: SelectionInput): Promise<PiState> {
  const args = [
    '--mode',
    'rpc',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-context-files',
    '--no-prompt-templates',
    input.toolPolicy === 'none' ? '--no-approve' : '--approve',
    '--offline',
    ...(input.model && input.model !== 'auto' ? ['--model', input.model] : []),
  ]
  const stdout = await executeMetadataQuery(
    {
      context: input,
      command: harnessCommand(
        input,
        { args },
        noAgentTerms('read Pi defaults without a prompt or saved session'),
      ),
      cwd: input.cwd,
      stdin: `${JSON.stringify({ id: 'podium-defaults', type: 'get_state' })}\n`,
    },
    15_000,
  )
  for (const line of stdout.split('\n')) {
    try {
      const frame = JSON.parse(line) as {
        type?: string
        command?: string
        success?: boolean
        data?: PiState
      }
      if (frame.type === 'response' && frame.command === 'get_state' && frame.success && frame.data)
        return frame.data
    } catch {
      /* Startup notices are not protocol responses. */
    }
  }
  throw new Error('Pi did not report its default model and thinking level')
}

export async function resolvePiSelection(
  input: SelectionInput,
  readState = readPiDefaults,
): Promise<{ model?: string; effort?: string }> {
  if (input.model !== 'auto' && input.effort !== 'auto')
    return { model: input.model, effort: input.effort }
  const defaults = await readState(input)
  if (input.model === 'auto' && !defaults.model)
    throw new Error('Pi has no available default model')
  if (input.effort === 'auto' && !defaults.thinkingLevel)
    throw new Error('Pi did not report its default thinking level')
  return {
    model:
      input.model === 'auto' ? `${defaults.model!.provider}/${defaults.model!.id}` : input.model,
    effort: input.effort === 'auto' ? defaults.thinkingLevel : input.effort,
  }
}
