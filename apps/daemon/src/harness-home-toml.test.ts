/**
 * The `toml-array-entry` edit's text work: where the entry lands in each
 * layout a person's config may have, that nothing else in the file changes,
 * and which files it refuses to touch.
 */
import { describe, expect, it } from 'vitest'
import { planTomlArrayEntry, tomlArrayHolds, tomlBasicString } from './harness-home-toml.js'

const PATH = ['permission', 'allow'] as const
const RULE = 'Bash(podium *)'

/** The planned body; fails the test when the plan is a refusal or a no-op. */
function next(body: string, value = RULE): string {
  const plan = planTomlArrayEntry(body, PATH, value)
  if ('reason' in plan) throw new Error(`refused: ${plan.reason}`)
  if (plan.next === undefined) throw new Error('planned no change')
  expect(tomlArrayHolds(plan.next, PATH, value)).toBe(true)
  return plan.next
}

function reason(body: string): string {
  const plan = planTomlArrayEntry(body, PATH, RULE)
  if (!('reason' in plan)) throw new Error(`expected a refusal, planned ${JSON.stringify(plan)}`)
  return plan.reason
}

describe('planTomlArrayEntry', () => {
  it('starts an empty file with the table and the key', () => {
    expect(next('')).toBe('[permission]\nallow = ["Bash(podium *)"]\n')
  })

  it('adds the table after the last line, with a blank line between', () => {
    expect(next('[ui]\nyolo = false\n')).toBe(
      '[ui]\nyolo = false\n\n[permission]\nallow = ["Bash(podium *)"]\n',
    )
    expect(next('[ui]\nyolo = false')).toBe(
      '[ui]\nyolo = false\n\n[permission]\nallow = ["Bash(podium *)"]\n',
    )
  })

  it('adds the key right under an existing table header that has no allow yet', () => {
    const body = '[permission] # mine\ndeny = ["Bash(rm *)"]\n\n[ui]\nyolo = false\n'
    expect(next(body)).toBe(
      '[permission] # mine\nallow = ["Bash(podium *)"]\ndeny = ["Bash(rm *)"]\n\n[ui]\nyolo = false\n',
    )
  })

  it('adds the key under a header on the last line with no newline', () => {
    expect(next('[permission]')).toBe('[permission]\nallow = ["Bash(podium *)"]\n')
  })

  it('appends to a one-line array, with or without a trailing comma', () => {
    expect(next('[permission]\nallow = ["Bash(git *)"]\n')).toBe(
      '[permission]\nallow = ["Bash(git *)", "Bash(podium *)"]\n',
    )
    expect(next('[permission]\nallow = ["Bash(git *)", ]\n')).toBe(
      '[permission]\nallow = ["Bash(git *)", "Bash(podium *)", ]\n',
    )
    expect(next('[permission]\nallow = [ ]  # none\n')).toBe(
      '[permission]\nallow = ["Bash(podium *)"]  # none\n',
    )
  })

  it('appends to a multi-line array on its own line, keeping a trailing comma style', () => {
    const body = '[permission]\nallow = [\n    "Bash(git *)",\n    "Bash(gh *)",  # gh\n]\n'
    expect(next(body)).toBe(
      '[permission]\nallow = [\n    "Bash(git *)",\n    "Bash(gh *)",  # gh\n    "Bash(podium *)",\n]\n',
    )
  })

  it('appends to an empty multi-line array that holds only a comment', () => {
    expect(next('[permission]\nallow = [\n  # nothing yet\n]\n')).toBe(
      '[permission]\nallow = [\n  # nothing yet\n  "Bash(podium *)"\n]\n',
    )
  })

  it('appends after the last item when the closing bracket shares its line', () => {
    expect(next('[permission]\nallow = [\n  "Bash(git *)",\n  "Bash(gh *)"]\n')).toBe(
      '[permission]\nallow = [\n  "Bash(git *)",\n  "Bash(gh *)", "Bash(podium *)"]\n',
    )
  })

  it('keeps CRLF line endings', () => {
    expect(next('[ui]\r\nyolo = false\r\n')).toBe(
      '[ui]\r\nyolo = false\r\n\r\n[permission]\r\nallow = ["Bash(podium *)"]\r\n',
    )
    expect(next('[permission]\r\nallow = [\r\n  "Bash(git *)"\r\n]\r\n')).toBe(
      '[permission]\r\nallow = [\r\n  "Bash(git *)",\r\n  "Bash(podium *)"\r\n]\r\n',
    )
  })

  it('appends to a dotted key at the root', () => {
    expect(next('permission.allow = ["Bash(git *)"]\n')).toBe(
      'permission.allow = ["Bash(git *)", "Bash(podium *)"]\n',
    )
  })

  it('reads past strings, multi-line values, nested tables and arrays of tables', () => {
    const body = [
      'title = "a [permission] that is not a header" # ]',
      "path = 'C:\\x\\]'",
      'notes = """',
      '[permission]',
      'allow = ["inside a string"]',
      '"""',
      'when = 1979-05-27 07:32:00Z',
      'inline = { a = [1, [2, 3]], b = { c = "}" } }',
      '[marketplace]',
      '  [[marketplace.sources]]',
      '  name = "xAI Official"',
      '[permission]',
      'allow = [',
      '  "Bash(echo \\"]\\")",',
      ']',
      '',
    ].join('\n')
    expect(next(body)).toBe(body.replace('",\n]\n', '",\n  "Bash(podium *)",\n]\n'))
  })

  it('plans no change when the array already holds the value, however it is spelled', () => {
    for (const body of [
      '[permission]\nallow = ["Bash(podium *)"]\n',
      "[permission]\nallow = ['Bash(podium *)']\n",
      '[permission]\nallow = ["Bash\\u0028podium *)"]\n',
      '[permission]\n"allow" = [\n  "x",\n  "Bash(podium *)", # here\n]\n',
      '[ "permission" ]\nallow = ["Bash(podium *)"]\n',
    ]) {
      expect(planTomlArrayEntry(body, PATH, RULE), body).toEqual({ next: undefined })
      expect(tomlArrayHolds(body, PATH, RULE), body).toBe(true)
    }
  })

  it('does not take a rule in another table or another key for the value', () => {
    const body = '[other]\nallow = ["Bash(podium *)"]\n[permission]\ndeny = ["Bash(podium *)"]\n'
    expect(next(body)).toBe(
      '[other]\nallow = ["Bash(podium *)"]\n[permission]\nallow = ["Bash(podium *)"]\ndeny = ["Bash(podium *)"]\n',
    )
  })

  it('refuses a file it cannot read', () => {
    for (const body of [
      '[permission\n',
      'allow = ["unterminated]\n',
      '[permission]\nallow = ["a" "b"]\n',
      'a = 1 b = 2\n',
      'x = """never closed\n',
    ]) {
      expect(reason(body), body).toMatch(/not TOML this edit can read .* on line \d+/)
    }
  })

  it('refuses an allow that is not an array', () => {
    expect(reason('[permission]\nallow = "Bash(git *)"\n')).toMatch(/is not an array/)
  })

  it('refuses a table written in a form a header cannot extend', () => {
    for (const body of [
      'permission = { deny = ["x"] }\n',
      'permission.deny = ["x"]\n',
      '[[permission]]\ndeny = ["x"]\n',
      'permission = "off"\n',
      '[permission]\nallow.x = 1\n',
      '[permission.allow]\nx = 1\n',
    ]) {
      expect(reason(body), body).toMatch(/written in a form this edit does not change/)
    }
  })

  it('refuses a path with no table', () => {
    const plan = planTomlArrayEntry('', ['allow'], RULE)
    expect(plan).toEqual({ reason: expect.stringMatching(/needs a table and a key/) })
  })

  it('writes the value as a basic string, escaped where TOML needs it', () => {
    expect(tomlBasicString('Bash(say "hi" \\ \t)')).toBe('"Bash(say \\"hi\\" \\\\ \\t)"')
    expect(next('', 'Bash(say "hi")')).toBe('[permission]\nallow = ["Bash(say \\"hi\\")"]\n')
  })
})
