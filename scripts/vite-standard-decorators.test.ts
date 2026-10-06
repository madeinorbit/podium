import { describe, expect, it } from 'vitest'
import { lowerDecorators, usesDecorators } from './vite-standard-decorators'

const decorated = `
function twice<T>(get: (this: T) => number, context: ClassGetterDecoratorContext<T, number>) {
  if (context.kind !== 'getter') throw new Error(context.kind)
  return function (this: T) { return get.call(this) * 2 }
}
class Base { constructor(readonly n: number) {} @twice get x() { return this.n } }
class Sub extends Base {
  @twice
  override get x() { return super.x + 1 }
}
;(globalThis as { decorated?: number[] }).decorated = [new Base(3).x, new Sub(3).x]
`

describe('standard decorators in Vite builds', () => {
  it('selects only TypeScript sources that use a decorator', () => {
    expect(usesDecorators(decorated, '/repo/packages/a/src/model.ts')).toBe(true)
    expect(usesDecorators(decorated, '/repo/apps/web/src/Row.tsx?v=1')).toBe(true)
    expect(usesDecorators('/**\n * @param x the value\n */\nexport const y = 1', '/repo/a.ts')).toBe(false)
    expect(usesDecorators('const mail = "a@b.c"', '/repo/a.ts')).toBe(false)
    expect(usesDecorators('class A {\n  @lazy({ equals: (a, b) => a === b }) get x() { return 1 }\n}', '/repo/a.ts')).toBe(true)
    expect(usesDecorators('class A {\n  @observable accessor x = 1\n}', '/repo/a.ts')).toBe(true)
    // CSS at-rules inside template strings, as in the app's inline styles.
    const tick = '`'
    for (const css of ['@media (prefers-reduced-motion: reduce) {', '@keyframes boot-scan{0%{opacity:0}}',
      '@keyframes ask-pulse-v {', '@keyframes spin {', '@font-face {'])
      expect(usesDecorators(`const style = ${tick}\n${css}\n${tick}`, '/repo/a.tsx')).toBe(false)
    expect(usesDecorators(decorated, '/repo/node_modules/x/index.ts')).toBe(false)
    expect(usesDecorators(decorated, '/repo/a.js')).toBe(false)
  })

  it('lowers standard getter decorators to code the engine can run', async () => {
    const { code, map } = await lowerDecorators(decorated, '/repo/packages/a/src/model.ts')
    expect(code).not.toMatch(/^\s*@twice/m)
    expect(JSON.parse(map).sources).toEqual(['/repo/packages/a/src/model.ts'])
    // Parsed by the engine itself, as a browser would: no transform in between.
    new Function(code)()
    expect((globalThis as { decorated?: number[] }).decorated).toEqual([6, 14])
  })
})
