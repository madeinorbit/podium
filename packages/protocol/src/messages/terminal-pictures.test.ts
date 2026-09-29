import { describe, expect, it } from 'vitest'
import { DaemonMessage } from './daemon'
import { BindMessage, GeometryAppliedMessage } from './terminal'

const bind = {
  type: 'bind',
  sessionId: 'session-1',
  cmd: 'sh',
  cwd: '/work',
  agentKind: 'shell',
}
const birth = {
  type: 'geometryApplied',
  sessionId: 'session-1',
  geometry: { cols: 120, rows: 40 },
  cause: 'request',
  birth: true,
}

describe('terminal picture announcements', () => {
  it('keeps old bind and geometry reports unchanged', () => {
    expect(BindMessage.parse(bind)).toEqual(bind)
    expect(GeometryAppliedMessage.parse(birth)).toEqual(birth)
    const { birth: _birth, ...report } = birth
    expect(GeometryAppliedMessage.parse(report)).toEqual(report)
  })

  it.each([bind, birth])('retains pictures on $type through the daemon parser', (message) => {
    const value = { ...message, pictures: true }
    expect(DaemonMessage.parse(value)).toEqual(value)
  })

  it.each([bind, birth])('rejects an invalid pictures flag on $type', (message) => {
    for (const pictures of [false, 1, 'true', null]) {
      expect(DaemonMessage.safeParse({ ...message, pictures }).success).toBe(false)
    }
  })
})
