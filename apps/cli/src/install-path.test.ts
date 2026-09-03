import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PATH_MARKER, pathHint, persistPath } from './install-path'

/** A box with every shell installed, unless a test says otherwise. */
const allShells = { shellExists: () => true }
const noShells = { shellExists: () => false }

/**
 * The behaviour ported from install.sh:300-367. The copy-paste install runs in ONE shell, so
 * exporting PATH there dies with the process: the next SSH login had no `podium` at all
 * (POD-327). These snippets are what make `podium` survive into future logins, and the file
 * SET matters as much as the content — each of .bash_profile / .bash_login / .zprofile
 * SHADOWS ~/.profile for its shell.
 */
describe('persistPath [R5]', () => {
  let home: string
  const bin = () => join(home, '.local/bin')
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'podium-path-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })
  const read = (rel: string) => readFileSync(join(home, rel), 'utf8')

  it('always writes ~/.profile — sh/dash login, and the last resort for bash', () => {
    const res = persistPath(bin(), home, allShells)
    expect(res.persisted).toBe(true)
    expect(read('.profile')).toContain(PATH_MARKER)
  })

  it('writes a PRESENT ~/.bash_profile, because it shadows ~/.profile for bash', () => {
    writeFileSync(join(home, '.bash_profile'), '# pre-existing\n')
    persistPath(bin(), home, allShells)
    expect(read('.bash_profile')).toContain(PATH_MARKER)
    expect(read('.bash_profile')).toContain('# pre-existing') // appended, never replaced
  })

  it('does NOT create an absent ~/.bash_profile, which would shadow ~/.profile anew', () => {
    persistPath(bin(), home, allShells)
    expect(existsSync(join(home, '.bash_profile'))).toBe(false)
    expect(existsSync(join(home, '.bash_login'))).toBe(false)
    expect(existsSync(join(home, '.zprofile'))).toBe(false)
  })

  it('is idempotent — a second run appends nothing and still reports persisted', () => {
    persistPath(bin(), home, allShells)
    const first = read('.profile')
    const second = persistPath(bin(), home, allShells)
    expect(read('.profile')).toBe(first)
    expect(second.written).toEqual([])
    expect(second.persisted).toBe(true)
  })

  it('writes the snippet UNEXPANDED so it re-resolves $HOME on every source', () => {
    // Baking the literal path in would break the moment $HOME moves, and would stack a
    // duplicate PATH entry on every source. The guard is why it does neither.
    persistPath(bin(), home, allShells)
    const body = read('.profile')
    // BOTH lines that name the directory must stay unexpanded — asserting only one let a
    // mutant that expanded the guard survive, because the assignment line still matched.
    expect(body).toContain('*":$HOME/.local/bin:"*) ;;')
    expect(body).toContain('PATH="$HOME/.local/bin${PATH:+:$PATH}"; export PATH')
    expect(body).toContain('case ":${PATH-}:" in')
    // No absolute home path of ANY kind: not this temp dir, and not the real $HOME either.
    expect(body).not.toContain(home)
    expect(body.split('\n').filter((l) => l.startsWith('/') || l.includes('=/'))).toEqual([])
  })

  it('gives fish its own conf.d file, since fish cannot parse the POSIX snippet', () => {
    mkdirSync(join(home, '.config/fish'), { recursive: true })
    persistPath(bin(), home, allShells)
    const fish = read('.config/fish/conf.d/podium-path.fish')
    expect(fish).toContain(PATH_MARKER)
    expect(fish).toContain('set -gx PATH $HOME/.local/bin $PATH')
    expect(fish).not.toContain('case ":${PATH-}:" in') // not the POSIX one
  })

  it('reports persisted when a PREVIOUS install already wrote the marker', () => {
    writeFileSync(join(home, '.profile'), `existing\n${PATH_MARKER}\nwhatever\n`)
    const res = persistPath(bin(), home, allShells)
    expect(res.written).not.toContain(join(home, '.profile'))
    expect(res.persisted).toBe(true)
  })

  it('leaves .zshrc and fish alone on a box that has neither shell', () => {
    // install.sh gated each of these on the shell existing or its rc already being there.
    // Creating ~/.zshrc where none exists hands zsh a file it would then start honouring.
    persistPath(bin(), home, noShells)
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
    expect(existsSync(join(home, '.config/fish/conf.d/podium-path.fish'))).toBe(false)
    expect(existsSync(join(home, '.profile'))).toBe(true) // still always written
  })

  it('extends an EXISTING .zshrc even when zsh is not on PATH', () => {
    writeFileSync(join(home, '.zshrc'), '# mine\n')
    persistPath(bin(), home, noShells)
    expect(read('.zshrc')).toContain(PATH_MARKER)
  })

  it('never throws when a startup file cannot be written', () => {
    // A read-only $HOME is a real state on locked-down images. Losing the snippet is a
    // degraded install, not a failed one — install.sh treated every write as non-fatal.
    const readonly = join(home, 'nope')
    expect(() =>
      persistPath(join(readonly, '.local/bin'), join(readonly, 'missing/deep')),
    ).not.toThrow()
  })
})

describe('pathHint — what the operator still has to do in THIS shell', () => {
  it('says nothing when the bin dir is already on PATH', () => {
    expect(pathHint('/x/bin', true, 'podium', '/a:/x/bin:/b')).toBeUndefined()
  })

  it('names the export for this shell when the snippet only reaches future ones', () => {
    const hint = pathHint('/x/bin', true, 'podium', '/a:/b')
    expect(hint).toContain('export PATH="/x/bin:$PATH"')
  })

  it('asks for the PATH change outright when nothing was persisted', () => {
    const hint = pathHint('/x/bin', false, 'podium', '/a:/b')
    expect(hint).toContain('/x/bin')
    expect(hint).not.toContain('New shells')
  })
})
