import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('shared hermetic setup in the web environment', () => {
  it('loads after happy-dom installs its URL global', () => {
    // Collection is the regression: the setup used to call happy-dom's URL
    // constructor with import.meta.url and throw before this body could run.
    expect(basename(tmpdir())).toMatch(/^podium-test-run-/)
  })
})
