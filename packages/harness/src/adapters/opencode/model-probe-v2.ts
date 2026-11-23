import { randomUUID } from 'node:crypto'
import { harnessCommand } from '../../bound-command.js'
import type { HarnessContext } from '../../harness-context.js'
import { queryMetadataServer } from '../../metadata-query.js'
import type { ModelChoice } from '../../model-probe.js'
import { noAgentTerms } from '../../posture.js'

export function parseOpencode2Models(out: string): ModelChoice[] {
  try {
    const { data } = JSON.parse(out) as {
      data: {
        id: string
        providerID: string
        name?: string
        enabled?: boolean
        variants?: { id: string }[]
      }[]
    }
    return data
      .filter((model) => model.enabled !== false)
      .map((model) => ({
        value: `${model.providerID}/${model.id}`,
        label: model.name ?? `${model.providerID}/${model.id}`,
        efforts: model.variants?.map((variant) => variant.id) ?? [],
      }))
  } catch {
    return []
  }
}

/** The preview's `models` command prints only ids and may read before plugins
 * settle. Its private stdio server supplies variant metadata without a session
 * or prompt, and shuts down when the metadata query finishes. */
export async function probeOpencode2Models(
  context: Pick<HarnessContext, 'installation' | 'env'>,
  timeoutMs: number,
): Promise<ModelChoice[]> {
  const password = randomUUID()
  return queryMetadataServer(
    {
      context,
      command: harnessCommand(
        context,
        {
          args: ['serve', '--stdio', '--port', '0', '--hostname', '127.0.0.1'],
          env: { OPENCODE_SERVER_PASSWORD: password },
        },
        noAgentTerms('enumerate OpenCode models without allocating a conversation'),
      ),
      ...(context.env.HOME ? { cwd: context.env.HOME } : {}),
      endpoint(line) {
        try {
          const value = JSON.parse(line) as { url?: string }
          if (value.url && new URL(value.url).hostname === '127.0.0.1') return value.url
        } catch {
          /* Only the endpoint announcement binds the probe. */
        }
        return undefined
      },
      async read(url, signal) {
        const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
        while (!signal.aborted) {
          const response = await fetch(`${url}/api/model`, { headers: { authorization }, signal })
          if (!response.ok) throw new Error('OpenCode refused the model metadata query')
          const models = parseOpencode2Models(await response.text())
          if (models.length) return models
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return []
      },
    },
    timeoutMs,
  )
}
