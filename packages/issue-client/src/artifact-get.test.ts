/**
 * `podium issue artifact <id> --get` (POD-1999) — reading a stored artifact back.
 *
 * The command's job on this path is presentation over one `issues.artifactRead`
 * call, and the two decisions that matter to a caller are made HERE: how the
 * artifact is named (a printed index, or its source path), and what happens to
 * the bytes (printed, saved, or described because printing them would corrupt
 * the terminal). Both are pinned below.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const artifact = () => {
  const entry = ISSUE_COMMANDS.find((c) => c.name === 'artifact')
  if (!entry) throw new Error('missing artifact command')
  return entry
}

function client(answer: unknown) {
  const artifactRead = vi.fn(async () => answer)
  const get = vi.fn(async () => ({ seq: 1, panel: { artifacts: [] } }))
  const panelApply = vi.fn(async () => ({ seq: 1, panel: { artifacts: [] } }))
  return {
    trpc: {
      issues: {
        artifactRead: { query: artifactRead },
        get: { query: get },
        panelApply: { mutate: panelApply },
      },
    } as unknown as IssueTrpc,
    artifactRead,
    panelApply,
  }
}

const answerFor = (body: string, over: Record<string, unknown> = {}) => ({
  index: 1,
  path: 'docs/plan.md',
  title: 'Plan',
  addedAt: '2026-08-13T00:00:00.000Z',
  artifactId: 'art1',
  entry: 'plan.md',
  files: [{ path: 'plan.md', size: body.length }],
  file: 'plan.md',
  contentType: 'text/markdown; charset=utf-8',
  size: body.length,
  url: '/files/artifact/iss_1/art1/plan.md',
  dataBase64: Buffer.from(body, 'utf8').toString('base64'),
  ...over,
})

async function run(a: Record<string, unknown>, answer: unknown) {
  const c = client(answer)
  const result = await artifact().run(c.trpc, { id: '7', ...a })
  return { ...c, result }
}

describe('artifact --get', () => {
  it('a numeric ref selects by index and a non-numeric one by source path', async () => {
    const byIndex = await run({ get: '2' }, answerFor('x'))
    expect(byIndex.artifactRead).toHaveBeenCalledWith({ id: '7', index: 2 })
    const byPath = await run({ get: 'docs/plan.md' }, answerFor('x'))
    expect(byPath.artifactRead).toHaveBeenCalledWith({ id: '7', path: 'docs/plan.md' })
  })

  it('passes --file through so one member of a bundle can be read', async () => {
    const { artifactRead } = await run({ get: '1', file: 'app.css' }, answerFor('body{}'))
    expect(artifactRead).toHaveBeenCalledWith({ id: '7', index: 1, file: 'app.css' })
  })

  it('prints text content, and carries it decoded in the structured payload', async () => {
    const { result } = await run({ get: '1' }, answerFor('# the plan'))
    expect(result.text).toBe('# the plan')
    expect(result.data).toMatchObject({ text: '# the plan', file: 'plan.md' })
    // The base64 does not ride the payload twice — the decoded text is the answer.
    expect(result.data).not.toHaveProperty('dataBase64')
  })

  it('describes a binary instead of spraying it, naming --out and the URL', async () => {
    // A body whose bytes are not the point: the routing decision is the CONTENT
    // TYPE. Kept plain ASCII — a literal NUL here would make this source file
    // binary to git and invisible to grep (scripts/check-no-nul-bytes.ts).
    const png = 'PNGDATA'
    const { result } = await run(
      { get: '1' },
      answerFor(png, { contentType: 'image/png', file: 'shot.png' }),
    )
    expect(result.text).toContain('--out')
    expect(result.text).toContain('/files/artifact/iss_1/art1/plan.md')
    expect(result.text).toContain('image/png')
    // The bytes themselves stay out of the terminal.
    expect(result.text).not.toContain('PNGDATA')
  })

  it('--out writes the bytes to disk, creating the parent directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-artifact-'))
    const out = join(dir, 'nested', 'plan.md')
    const { result } = await run({ get: '1', out }, answerFor('# the plan'))
    expect(await readFile(out, 'utf8')).toBe('# the plan')
    expect(result.text).toContain(out)
  })

  it('mentions the other bundle members so the reader knows what else is stored', async () => {
    const { result } = await run(
      { get: '1' },
      answerFor('<html>', {
        contentType: 'text/html; charset=utf-8',
        file: 'index.html',
        entry: 'index.html',
        files: [
          { path: 'index.html', size: 6 },
          { path: 'app.css', size: 6 },
        ],
      }),
    )
    expect(result.text).toContain('bundle of 2')
    expect(result.text).toContain('app.css')
  })

  it('refuses --file/--out without --get rather than silently listing', async () => {
    const c = client(answerFor('x'))
    await expect(artifact().run(c.trpc, { id: '7', out: '/tmp/x' })).rejects.toThrow(/only apply/)
  })
})

describe('artifact --add terminal evidence', () => {
  it('sends explicit acknowledgement and the current checkout root', async () => {
    const c = client(undefined)
    await artifact().run(c.trpc, {
      id: '7',
      add: 'artifacts/live.png',
      terminalEvidence: true,
    })
    expect(c.panelApply).toHaveBeenCalledWith({
      id: '7',
      op: 'artifact-add',
      path: 'artifacts/live.png',
      terminalEvidence: true,
      sourceRoot: process.cwd(),
    })
  })

  it('does not let the acknowledgement silently become a list or remove operation', async () => {
    const c = client(undefined)
    await expect(
      artifact().run(c.trpc, { id: '7', terminalEvidence: true }),
    ).rejects.toThrow(/only applies to --add/)
    expect(c.panelApply).not.toHaveBeenCalled()
  })
})
