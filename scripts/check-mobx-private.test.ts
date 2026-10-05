import { describe, expect, it } from 'vitest'
import { mobxPrivateUses } from './check-mobx-private'

const file = 'packages/client-graph/src/planted.ts'
describe('MobX private API boundary', () => {
  it.each([
    "import { _isComputingDerivation as tracked } from 'mobx'; tracked()",
    "export { _getGlobalState as state } from 'mobx'",
    "import * as mobx from 'mobx'; mobx._isComputingDerivation()",
    "import * as mobx from 'mobx'; mobx['_getGlobalState']()",
    "const mobx = require('mobx'); const alias = mobx; alias._getGlobalState()",
    "const { _getGlobalState: state } = require('mobx')",
    "(await import('mobx'))._getGlobalState()",
    "require('mobx')._getGlobalState()",
    "import * as mobx from 'mobx'; Reflect.get(mobx, '_getGlobalState')()",
    "import { computed } from 'mobx/dist/internal'",
    "require('mobx/dist/internal')",
    "export * from 'mobx'",
  ])('rejects private access: %s', source => {
    expect(mobxPrivateUses(source, file).length).toBeGreaterThan(0)
  })
  it('permits only the named tracking import inside the helper', () => {
    const helper = 'packages/mobx-helpers/src/keyed-computed.ts'
    expect(mobxPrivateUses("import { _getGlobalState } from 'mobx'", helper)).toEqual([])
    expect(mobxPrivateUses("import { _isComputingDerivation } from 'mobx'", helper)).toHaveLength(1)
    expect(mobxPrivateUses("export { _getGlobalState } from 'mobx'", helper)).toHaveLength(1)
  })
  it('permits public observation and ignores private-looking text', () => {
    expect(mobxPrivateUses("import { computed, getAtom } from 'mobx'; getAtom(computed(() => 1)).reportObserved()", file)).toEqual([])
    expect(mobxPrivateUses("const text = `import { _getGlobalState } from 'mobx'` // mobx._getGlobalState()", file)).toEqual([])
  })
})
