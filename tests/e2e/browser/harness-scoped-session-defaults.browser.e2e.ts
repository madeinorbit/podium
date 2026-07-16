import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { nativeAccountId, normalizeSettings } from '../../../packages/runtime/src/settings'
import { harnessEnv } from '../harness-env'
import { newSession, openApp } from './_harness'

const PORT = Number(process.env.PORT ?? 8799)
const launchLogFile = `${harnessEnv(PORT).stateDir}/launch-log.jsonl`

interface LaunchRecord {
  agentKind: string
  model?: string
  effort?: string
}

function latestLaunch(): LaunchRecord | undefined {
  try {
    const lines = readFileSync(launchLogFile, 'utf8').trim().split('\n')
    return JSON.parse(lines.at(-1) ?? '') as LaunchRecord
  } catch {
    return undefined
  }
}

test('selected alternate harness omits configured defaults', async ({ page }) => {
  const trpc = makeTrpc(`http://localhost:${PORT}`)
  await trpc.settings.set.mutate(
    normalizeSettings({
      roles: {
        coding: {
          accountId: nativeAccountId('claude-code'),
          model: 'opus',
          effort: 'high',
        },
      },
    }),
  )

  await openApp(page)
  await newSession(page, 'Codex')

  await expect.poll(latestLaunch, { timeout: 15_000 }).toEqual({ agentKind: 'codex' })
})
