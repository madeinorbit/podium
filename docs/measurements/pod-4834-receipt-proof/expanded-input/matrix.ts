// POD-4984: ASCII bodies make byte counts unambiguous; frames deliberately add UTF-8 dots.
import { createHash } from 'node:crypto'

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const lines = (n: number) => Array.from({ length: n }, (_, i) =>
  `P4984-lines-${n} line-${String(i + 1).padStart(3, '0')} payload-END-${i + 1}`).join('\n')
const long = (n: number) => {
  const head = `P4984-single-${n} BEGIN `, tail = ` END-${n}`
  return head + '0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n - head.length - tail.length) + tail
}
const shapes: Record<string, string> = {
  'lines-2': lines(2), 'lines-10': lines(10), 'lines-200': lines(200),
  'single-1024': long(1024), 'single-16384': long(16384), 'single-102400': long(102400),
  tabs: 'P4984-tabs\tmiddle\tindented\tEND-tabs',
  crlf: 'P4984-crlf line-1\r\nP4984-crlf line-2\r\nP4984-crlf END',
  'trailing-lf': 'P4984-trailing-lf first\nP4984-trailing-lf END\n',
}
export const cases = Object.entries(shapes).flatMap(([shape, body]) => {
  return [false, true].map(framed => {
    const name = `${shape}-${framed ? 'frame' : 'plain'}`
    const hex = sha(name).slice(0, 32)
    const id = `msg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex.slice(20, 32)}`
    return { name, shape, framed, id, body,
      text: framed ? `[podium message ${id} · from agent · to you]\n${body}\n[end podium message ${id}]` : body }
  })
})
