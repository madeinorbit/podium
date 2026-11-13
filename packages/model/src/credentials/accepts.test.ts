import { describe, expect, it } from 'vitest'
import { acceptsProblems, INFERENCE_ROUTES } from './accepts'
import { CREDENTIAL_TYPES } from './types'

describe('INFERENCE_ROUTES', () => {
  it('has the five routes that do not wait on measurement S5', () => {
    expect(INFERENCE_ROUTES).toEqual({
      'anthropic.api-key': { kind: 'http', api: 'anthropic-messages' },
      'openai.api-key': { kind: 'http', api: 'openai-chat' },
      'openrouter.api-key': { kind: 'http', api: 'openai-chat', base: 'openrouter' },
      'openai.chatgpt-login': { kind: 'on-machine', api: 'openai-responses' },
      'openai.chatgpt-plan': { kind: 'http', api: 'openai-responses' },
    })
  })
})

describe('acceptsProblems', () => {
  const types = {
    'a.key': CREDENTIAL_TYPES['anthropic.api-key'],
    'b.key': CREDENTIAL_TYPES['openai.api-key'],
  }

  it('finds nothing when every type is used once per driver', () => {
    expect(
      acceptsProblems({
        types,
        routes: { 'b.key': { kind: 'http', api: 'openai-chat' } },
        consumers: [{ kind: 'one', accepts: [{ type: 'a.key' }] }],
      }),
    ).toEqual([])
  })

  it('reports a type no consumer accepts and no route serves', () => {
    expect(
      acceptsProblems({
        types,
        routes: {},
        consumers: [{ kind: 'one', accepts: [{ type: 'a.key' }] }],
      }),
    ).toEqual([{ kind: 'unused-type', type: 'b.key' }])
  })

  it('reports a type id that is not in the registry', () => {
    expect(
      acceptsProblems({
        types,
        routes: {},
        consumers: [
          { kind: 'one', accepts: [{ type: 'a.key' }, { type: 'b.key' }, { type: 'c.key' }] },
        ],
      }),
    ).toEqual([{ kind: 'unknown-type', consumer: 'one', type: 'c.key' }])
  })

  it('allows one type twice on disjoint drivers', () => {
    expect(
      acceptsProblems({
        types,
        routes: {},
        consumers: [
          {
            kind: 'one',
            accepts: [
              { type: 'a.key', drivers: ['x'] },
              { type: 'a.key', drivers: ['y'] },
              { type: 'b.key' },
            ],
          },
        ],
      }),
    ).toEqual([])
  })

  it('reports one type twice on overlapping drivers, where no drivers means all', () => {
    for (const pair of [
      [{ drivers: ['x', 'y'] }, { drivers: ['y'] }],
      [{}, { drivers: ['y'] }],
      [{ drivers: ['x'] }, {}],
      [{}, {}],
    ]) {
      expect(
        acceptsProblems({
          types,
          routes: {},
          consumers: [
            {
              kind: 'one',
              accepts: [
                { type: 'a.key', ...pair[0] },
                { type: 'a.key', ...pair[1] },
                { type: 'b.key' },
              ],
            },
          ],
        }),
        JSON.stringify(pair),
      ).toEqual([{ kind: 'duplicate-type', consumer: 'one', type: 'a.key' }])
    }
  })

  it('does not count the same type on two different consumers as a duplicate', () => {
    expect(
      acceptsProblems({
        types,
        routes: {},
        consumers: [
          { kind: 'one', accepts: [{ type: 'a.key' }] },
          { kind: 'two', accepts: [{ type: 'a.key' }, { type: 'b.key' }] },
        ],
      }),
    ).toEqual([])
  })
})
