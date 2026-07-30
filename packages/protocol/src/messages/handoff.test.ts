import { describe, expect, it } from 'vitest'
import { DaemonMessage } from './daemon'
import { HandoffExportResultMessage, HandoffImportResultMessage } from './handoff'

/**
 * POD-643: the manifest's own vocabulary lives in `@podium/model`; what the
 * FRAMES must be able to say is that a handoff was refused, and WHICH kind of
 * refusal it was (ADR 9 D6 M5). Enforcement is POD-1079 / POD-323's — these
 * tests pin that the frames can carry the distinction at all, and that adding
 * the ability did not change an existing result.
 */
describe('handoff result frames', () => {
  const importOk = { type: 'handoffImportResult' as const, requestId: 'r1', ok: true }

  it('distinguishes an unauthorized target from an unreachable one', () => {
    const unauthorized = HandoffImportResultMessage.parse({
      ...importOk,
      ok: false,
      refusal: 'unauthorized',
      error: 'not permitted to use the target machine',
    })
    const unreachable = HandoffImportResultMessage.parse({
      ...importOk,
      ok: false,
      refusal: 'unreachable',
      error: 'target machine is offline',
    })
    expect(unauthorized.refusal).toBe('unauthorized')
    expect(unreachable.refusal).toBe('unreachable')
  })

  it('rejects a refusal outside the closed set, so a call site cannot invent one', () => {
    expect(() =>
      HandoffImportResultMessage.parse({ ...importOk, ok: false, refusal: 'denied' }),
    ).toThrow()
  })

  it('still parses a result that carries no refusal', () => {
    expect(HandoffImportResultMessage.parse(importOk)).toEqual(importOk)
  })

  it('carries the refusal on the export result too — `use` gates the source machine as well', () => {
    const refused = HandoffExportResultMessage.parse({
      type: 'handoffExportResult',
      requestId: 'r1',
      ok: false,
      refusal: 'unknown-target',
    })
    expect(refused.refusal).toBe('unknown-target')
  })

  it('survives the DaemonMessage union, which is how a result actually arrives', () => {
    const parsed = DaemonMessage.parse({ ...importOk, ok: false, refusal: 'unreachable' })
    expect(parsed).toMatchObject({ type: 'handoffImportResult', refusal: 'unreachable' })
  })
})
