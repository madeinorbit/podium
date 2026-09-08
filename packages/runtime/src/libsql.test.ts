import { describe, expect, it } from 'vitest'
import { normalizeLibsqlUrl } from './libsql'

describe('normalizeLibsqlUrl', () => {
  it('rewrites turso:// to libsql:// and leaves other schemes alone', () => {
    expect(normalizeLibsqlUrl('turso://db.example')).toBe('libsql://db.example')
    expect(normalizeLibsqlUrl('libsql://db.example')).toBe('libsql://db.example')
    expect(normalizeLibsqlUrl('https://db.example')).toBe('https://db.example')
  })
})
