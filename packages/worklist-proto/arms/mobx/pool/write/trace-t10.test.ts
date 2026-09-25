import { describe, expect, it } from 'vitest'
import { createEngineLocals } from '../../../../harness/src/engine-locals'
import { ArmEditAdapter } from '../../../../shared/src/gen/arm-edits'
import { gen } from '../../../../shared/src/gen/changes'
import { checkArm, type CheckedArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import { installMobxWarnTrap } from '../mobx-trap'
import { writableMobxPoolArm, type WritableMobxPoolHandle } from './arm'

installMobxWarnTrap()

describe('trace t10 drop', () => {
  it('logs every log call for seed 2 to step 140', async () => {
    const { appendFileSync } = await import('node:fs')
    const log = (s: string): void => appendFileSync('/tmp/t10-trace.txt', `${s}\n`)
    const adapter = new ArmEditAdapter()
    const arm: CheckedArm = (ctx: ScenarioEngine) => {
      const inner = writableMobxPoolArm(adapter.transport(ctx))
      return {
        create: (source, locals, reads) => {
          const handle = inner.create(source, locals, reads) as WritableMobxPoolHandle
          adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
          const pending = handle.write.log
          const wrap = <T extends object, M extends keyof T>(obj: T, method: M): void => {
            const orig = obj[method] as (...args: never[]) => unknown
            ;(obj as Record<string, unknown>)[method as string] = (...args: never[]) => {
              const out = orig(...args)
              log(`log.${String(method)}(${JSON.stringify(args).slice(0, 160)}) => ${JSON.stringify(out)?.slice(0, 160)}`)
              return out
            }
          }
          wrap(pending, 'append')
          wrap(pending, 'settle')
          wrap(pending, 'reject')
          wrap(pending, 'supersede')
          wrap(pending, 'remote')
          wrap(pending, 'expire')
          const w = handle.write
          for (const m of ['handleRemote', 'handleAccepted', 'handleSuperseded', 'reject', 'edit'] as const) {
            const orig = w[m].bind(w)
            ;(w as Record<string, unknown>)[m] = (...args: never[]) => {
              const out = (orig as (...a: never[]) => unknown)(...args)
              log(`api.${m}(${JSON.stringify(args).slice(0, 200)})`)
              return out
            }
          }
          return handle
        },
      }
    }
    const sequence = gen(2, 140, {}, { editFields: ['title', 'readAt'] })
    const result = await checkArm(arm, sequence, {
      mode: 'truth',
      oracleEvery: 0,
      rebuildEvery: 0,
      shrink: false,
      editViaArm: adapter.editHook,
      onStep: (step) => {
        adapter.pairFromStep(step.detail ?? {})
        if (step.change.kind === 'edit' || step.change.kind === 'accept' || step.change.kind === 'reject') {
          log(`--- step ${step.index} ${JSON.stringify(step.change).slice(0, 160)} detail=${JSON.stringify(step.detail ?? {}).slice(0, 200)}`)
        }
      },
    })
    log(`done ok=${result.ok}`)
    expect(true).toBe(true)
  }, 1_200_000)
})
