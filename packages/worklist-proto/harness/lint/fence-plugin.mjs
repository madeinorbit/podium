/**
 * POD-4563 (L6a) — the lint fence: one ESLint plugin, the same rules for
 * every round-three arm. See `README.md` in this folder for the manifest and
 * each rule's reason; `fence-lint.test.ts` proves every rule fires on a
 * planted file and stays quiet on its clean twin.
 *
 * Syntactic, like the MobX arm's rules (no type information: typescript-eslint
 * refuses the repository's TypeScript 7 compiler), so the parser is Babel's.
 * An arm is a folder `arms/<folder>/`; its manifest is `fence.json` there.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import babelParser from '@babel/eslint-parser'

// ---------------------------------------------------------------- the arm

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

/** The arm folder a file belongs to: the path segment after the LAST `arms`. */
function armOf(filename) {
  const parts = resolve(filename).split(sep)
  const at = parts.lastIndexOf('arms')
  if (at < 0 || at + 2 >= parts.length) return null
  const root = parts.slice(0, at + 2).join(sep)
  return { folder: parts[at + 1], root, path: parts.slice(at + 2).join('/') }
}

const manifestCache = new Map()

/** `{ manifest, problem }` for an arm root. Cached per lint process. */
function readManifest(root) {
  const cached = manifestCache.get(root)
  if (cached !== undefined) return cached
  const file = join(root, 'fence.json')
  let result
  if (!existsSync(file)) {
    result = { manifest: null, problem: 'missing' }
  } else {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const lists = ['enumeration', 'tables', 'store', 'rows']
      const bad = lists.filter(
        (key) => !Array.isArray(raw[key]) || raw[key].some((entry) => typeof entry !== 'string'),
      )
      result =
        bad.length > 0
          ? { manifest: null, problem: `fence.json needs string arrays ${bad.join(', ')}` }
          : { manifest: raw, problem: null }
    } catch (error) {
      result = { manifest: null, problem: `fence.json does not parse: ${error.message}` }
    }
  }
  manifestCache.set(root, result)
  return result
}

/** Manifest entries are arm-relative paths; one ending in `/` names a folder. */
function listed(entries, path) {
  return entries.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
}

/** The arm and its manifest for a non-test file, or null when a rule does not apply. */
function fencedArm(context) {
  const filename = context.filename
  if (TEST_FILE.test(filename)) return null
  const arm = armOf(filename)
  if (arm === null) return null
  const { manifest } = readManifest(arm.root)
  if (manifest === null) return null
  return { ...arm, manifest }
}

// --------------------------------------------------------- AST helpers

function unwrap(node) {
  let current = node
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression
  }
  return current
}

/** The name a node reads a table through: `issues`, `pool.issues`, `pool['issues']`. */
function nameOf(node) {
  const target = unwrap(node)
  if (!target) return null
  if (target.type === 'Identifier') return target.name
  if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
    if (!target.computed && target.property.type === 'Identifier') return target.property.name
    if (
      target.computed &&
      target.property.type === 'Literal' &&
      typeof target.property.value === 'string'
    ) {
      return target.property.value
    }
    if (target.computed && target.property.type === 'StringLiteral') return target.property.value
  }
  return null
}

function isMember(node, objectName, propertyName) {
  const target = unwrap(node)
  return (
    target &&
    (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') &&
    !target.computed &&
    target.object.type === 'Identifier' &&
    target.object.name === objectName &&
    target.property.type === 'Identifier' &&
    target.property.name === propertyName
  )
}

// ---------------------------------------------------------- rule: manifest

const armManifest = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every arm folder carries a valid fence.json with exactly one enumeration module, named in its README',
    },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        if (TEST_FILE.test(context.filename)) return
        const arm = armOf(context.filename)
        if (arm === null) return
        const { manifest, problem } = readManifest(arm.root)
        if (problem === 'missing') {
          context.report({
            node,
            message: `arm folder "${arm.folder}" has no fence.json: every arm under arms/ declares its enumeration module, tables, store and row modules (harness/lint/README.md)`,
          })
          return
        }
        if (manifest === null) {
          context.report({ node, message: `arm "${arm.folder}": ${problem}` })
          return
        }
        if (manifest.enumeration.length !== 1) {
          context.report({
            node,
            message: `arm "${arm.folder}": fence.json must name exactly one enumeration module (the visible-set builder), not ${manifest.enumeration.length}`,
          })
          return
        }
        const readme = join(arm.root, 'README.md')
        const text = existsSync(readme) ? readFileSync(readme, 'utf8') : ''
        if (!text.includes(manifest.enumeration[0])) {
          context.report({
            node,
            message: `arm "${arm.folder}": README.md must name the enumeration module "${manifest.enumeration[0]}" (the explicit allow-list)`,
          })
        }
      },
    }
  },
}

// -------------------------------------------------------- rule: table walk

const WALK_METHODS = new Set(['values', 'keys', 'entries', 'forEach'])

const noTableWalk = {
  meta: {
    type: 'problem',
    docs: { description: 'Only the arm’s one enumeration module may enumerate a shared table' },
    schema: [],
  },
  create(context) {
    const arm = fencedArm(context)
    if (arm === null || listed(arm.manifest.enumeration, arm.path)) return {}
    const tables = new Set(arm.manifest.tables)
    const report = (node, table, how) =>
      context.report({
        node,
        message: `${how} over shared table "${table}" outside the enumeration module (${arm.manifest.enumeration[0]}): a whole-table walk costs the corpus, not the change`,
      })
    const check = (node, target, how) => {
      const name = nameOf(target)
      if (name !== null && tables.has(name)) report(node, name, how)
    }
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee)
        if (
          callee &&
          (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
        ) {
          const method = nameOf(callee)
          if (method !== null && WALK_METHODS.has(method))
            check(node, callee.object, `.${method}()`)
          if (isMember(callee, 'Array', 'from') && node.arguments[0])
            check(node, node.arguments[0], 'Array.from')
          for (const method of ['keys', 'values', 'entries']) {
            if (isMember(callee, 'Object', method) && node.arguments[0])
              check(node, node.arguments[0], `Object.${method}`)
          }
        }
      },
      NewExpression(node) {
        const callee = unwrap(node.callee)
        if (
          callee?.type === 'Identifier' &&
          ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(callee.name) &&
          node.arguments[0]
        ) {
          check(node, node.arguments[0], `new ${callee.name}(…)`)
        }
      },
      ForOfStatement(node) {
        check(node.right, node.right, 'for…of')
      },
      ForInStatement(node) {
        check(node.right, node.right, 'for…in')
      },
      SpreadElement(node) {
        check(node, node.argument, 'spread')
      },
    }
  },
}

// ------------------------------------------------- rule: store in component

const IMPORT_SOURCES = [
  // `import x from '…'`, `import { a } from '…'`, `export … from '…'` — type-only forms dropped below.
  /(^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function valueImports(text) {
  const out = []
  for (const pattern of IMPORT_SOURCES) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (pattern === IMPORT_SOURCES[0]) {
        if (match[3] !== undefined) continue // `import type` / `export type`
        const clause = match[4] ?? ''
        // `import { type A, type B } from` carries no value.
        const inner = clause.match(/^\s*\{([^}]*)\}\s*from\s+$/)
        if (
          inner &&
          inner[1].split(',').every((part) => part.trim() === '' || part.trim().startsWith('type '))
        )
          continue
        out.push(match[5])
      } else {
        out.push(match[1])
      }
    }
  }
  return out
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx']

function resolveLocal(fromFile, source) {
  if (!source.startsWith('.')) return null
  const base = resolve(dirname(fromFile), source)
  for (const extension of EXTENSIONS) {
    const candidate = base + extension
    if (existsSync(candidate) && !candidate.endsWith(sep)) {
      try {
        readFileSync(candidate)
        return candidate
      } catch {
        // a directory; keep looking
      }
    }
  }
  return null
}

/** The first store module `file` reaches through value imports inside the arm, as a chain, or null. */
function storeChain(file, arm, seen = new Set()) {
  if (seen.has(file)) return null
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  for (const source of valueImports(text)) {
    const target = resolveLocal(file, source)
    if (target === null) continue
    const path = relative(arm.root, target).split(sep).join('/')
    if (path.startsWith('..')) continue
    if (listed(arm.manifest.store, path)) return [path]
    const deeper = storeChain(target, arm, seen)
    if (deeper !== null) return [path, ...deeper]
  }
  return null
}

function hasJsx(sourceCode) {
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return false
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') return true
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue
      const child = node[key]
      if (Array.isArray(child)) {
        if (child.some((entry) => entry && typeof entry === 'object' && visit(entry))) return true
      } else if (child && typeof child === 'object' && visit(child)) {
        return true
      }
    }
    return false
  }
  return visit(sourceCode.ast)
}

const noStoreInComponent = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A component or row module may not reach a store module through a value import',
    },
    schema: [],
  },
  create(context) {
    const arm = fencedArm(context)
    if (arm === null) return {}
    const isRow = listed(arm.manifest.rows, arm.path)
    return {
      'Program:exit'(program) {
        if (listed(arm.manifest.store, arm.path)) return
        if (!isRow && !hasJsx(context.sourceCode)) return
        const kind = isRow ? 'row module' : 'component file'
        for (const source of valueImports(context.sourceCode.text)) {
          const target = resolveLocal(context.filename, source)
          if (target === null) continue
          const path = relative(arm.root, target).split(sep).join('/')
          if (path.startsWith('..')) continue
          const deeper = listed(arm.manifest.store, path) ? [] : storeChain(target, arm)
          if (deeper === null) continue
          const chain = [path, ...deeper]
          context.report({
            node: program,
            message: `${kind} imports the store: '${source}' reaches ${chain.join(' → ')}. A row gets its RowView and nothing else; a list gets the store through props (import type is fine)`,
          })
        }
      },
    }
  },
}

// --------------------------------------------------- rule: row component

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name)
    if (variable) return variable
  }
  return null
}

const rowComponentModuleScope = {
  meta: {
    type: 'problem',
    docs: { description: 'The component passed to RowShell is a module-scope identifier' },
    schema: [],
  },
  create(context) {
    const arm = fencedArm(context)
    if (arm === null) return {}
    const checkValue = (node, value) => {
      const target = unwrap(value)
      if (!target || target.type !== 'Identifier') {
        context.report({
          node,
          message:
            'RowShell component must be an identifier declared at module scope, not an inline expression (a closure is how a store gets in)',
        })
        return
      }
      const variable = findVariable(context.sourceCode.getScope(node), target.name)
      const scopeType = variable?.scope?.type
      if (scopeType !== 'module' && scopeType !== 'global') {
        context.report({
          node,
          message: `RowShell component "${target.name}" is declared inside a function: declare the row component once at module scope, where it cannot close over a store`,
        })
      }
    }
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'RowShell') return
        for (const attribute of node.attributes) {
          if (attribute.type !== 'JSXAttribute' || attribute.name.name !== 'component') continue
          const value =
            attribute.value?.type === 'JSXExpressionContainer'
              ? attribute.value.expression
              : attribute.value
          checkValue(attribute, value)
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        const isCreate =
          (callee?.type === 'Identifier' && callee.name === 'createElement') ||
          (callee?.type === 'MemberExpression' && nameOf(callee) === 'createElement')
        if (!isCreate) return
        const [type, props] = node.arguments
        if (unwrap(type)?.type !== 'Identifier' || unwrap(type).name !== 'RowShell') return
        if (props?.type !== 'ObjectExpression') return
        for (const property of props.properties) {
          if (
            property.type === 'Property' &&
            nameOf({
              type: 'MemberExpression',
              computed: property.computed,
              property: property.key,
            }) === 'component'
          ) {
            checkValue(property, property.value)
          }
        }
      },
    }
  },
}

// ------------------------------------------------------- rule: wall clock

const noWallClock = {
  meta: {
    type: 'problem',
    docs: { description: 'No wall clock in arms: time is SliceLocals.coarseNow' },
    schema: [],
  },
  create(context) {
    const isTest = TEST_FILE.test(context.filename)
    const message = 'wall clock in an arm: time is data (SliceLocals.coarseNow), never Date.now()'
    return {
      MemberExpression(node) {
        if (isMember(node, 'Date', 'now')) context.report({ node, message })
      },
      NewExpression(node) {
        if (
          !isTest &&
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Date' &&
          node.arguments.length === 0
        ) {
          context.report({ node, message: `${message} (new Date() reads it too)` })
        }
      },
      CallExpression(node) {
        if (!isTest && node.callee.type === 'Identifier' && node.callee.name === 'Date') {
          context.report({ node, message: `${message} (Date() reads it too)` })
        }
      },
    }
  },
}

// ----------------------------------------------------- rule: hidden state

const CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array'])
const OBSERVABLE_FACTORIES = new Set(['observable', 'makeObservable', 'makeAutoObservable'])

const noHiddenState = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No module-scope mutable state and no #private fields in arm code: state lives on the pool, reachable from the handle, where the copy sweep and the reads fence can see it',
    },
    schema: [],
  },
  create(context) {
    const arm = fencedArm(context)
    if (arm === null) return {}
    const moduleScope =
      'module-scope state in an arm (pitfall j: untracked state read inside a derivation); keep state on the pool'
    const checkDeclaration = (declaration) => {
      if (declaration.kind !== 'const') {
        context.report({
          node: declaration,
          message: `${moduleScope}: module-scope \`${declaration.kind}\``,
        })
        return
      }
      for (const declarator of declaration.declarations) {
        const init = unwrap(declarator.init)
        if (!init) continue
        if (
          init.type === 'NewExpression' &&
          init.callee.type === 'Identifier' &&
          CONTAINERS.has(init.callee.name)
        ) {
          context.report({
            node: declarator,
            message: `${moduleScope}: module-scope new ${init.callee.name}()`,
          })
        }
        if (init.type === 'CallExpression') {
          const callee = unwrap(init.callee)
          const root = callee?.type === 'MemberExpression' ? unwrap(callee.object) : callee
          if (root?.type === 'Identifier' && OBSERVABLE_FACTORIES.has(root.name)) {
            context.report({
              node: declarator,
              message: `${moduleScope}: module-scope ${root.name}(…)`,
            })
          }
        }
      }
    }
    return {
      Program(program) {
        for (const statement of program.body) {
          const declaration =
            statement.type === 'VariableDeclaration'
              ? statement
              : (statement.type === 'ExportNamedDeclaration' ||
                    statement.type === 'ExportDefaultDeclaration') &&
                  statement.declaration?.type === 'VariableDeclaration'
                ? statement.declaration
                : null
          if (declaration !== null) checkDeclaration(declaration)
        }
      },
      PropertyDefinition(node) {
        if (node.key.type === 'PrivateIdentifier' || node.key.type === 'PrivateName') {
          context.report({
            node,
            message:
              'a #private field hides state from the copy sweep; use a plain (TypeScript `private`) field',
          })
        }
      },
      ClassPrivateProperty(node) {
        context.report({
          node,
          message:
            'a #private field hides state from the copy sweep; use a plain (TypeScript `private`) field',
        })
      },
    }
  },
}

// ---------------------------------------------------- rule: thawed import fence

/**
 * POD-4565 (coordinator ruling on Ma1): a THAWED folder is round-three code
 * inside a frozen round-two arm (`arms/mobx/pool/`). The frozen files are not
 * linted, so an import from them would carry round two's shape (its
 * hand-maintained buckets, its stats) into round three unseen. A thawed file
 * may import nothing under `arms/` outside its own thawed folder — type
 * imports and re-exports included. Round-two IDEAS are rewritten, never
 * imported.
 */
const thawedImportFence = {
  meta: {
    type: 'problem',
    docs: { description: 'A thawed (round-three) folder imports nothing from the rest of arms/' },
    schema: [
      {
        type: 'object',
        properties: { thawed: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const thawed = context.options[0]?.thawed ?? []
    const arm = armOf(context.filename)
    if (arm === null) return {}
    const armsDir = dirname(arm.root)
    const armPath = `${arm.folder}/${arm.path}`
    const own = thawed.find((folder) => armPath.startsWith(`${folder}/`))
    if (own === undefined) return {}
    const ownDir = join(armsDir, own)
    const check = (node, source) => {
      if (typeof source !== 'string' || !source.startsWith('.')) return
      const target = resolve(dirname(resolve(context.filename)), source)
      const inArms = target === armsDir || target.startsWith(`${armsDir}${sep}`)
      const inOwn = target === ownDir || target.startsWith(`${ownDir}${sep}`)
      if (inArms && !inOwn) {
        context.report({
          node,
          message: `thawed folder "${own}" imports '${source}' (${relative(armsDir, target).split(sep).join('/')}), outside itself under arms/: round-two code is rewritten in the pool, never imported`,
        })
      }
    }
    return {
      ImportDeclaration(node) {
        check(node, node.source.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value)
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' || node.source.type === 'StringLiteral') check(node, node.source.value)
      },
      CallExpression(node) {
        if (node.callee.type === 'Import' && node.arguments[0]) {
          const arg = node.arguments[0]
          if (arg.type === 'Literal' || arg.type === 'StringLiteral') check(node, arg.value)
        }
      },
    }
  },
}

// ------------------------------------------------------------------ plugin

export const plugin = {
  meta: { name: 'worklist-fence' },
  rules: {
    'arm-manifest': armManifest,
    'no-table-walk': noTableWalk,
    'no-store-in-component': noStoreInComponent,
    'row-component-module-scope': rowComponentModuleScope,
    'no-wall-clock': noWallClock,
    'no-hidden-state': noHiddenState,
    'thawed-import-fence': thawedImportFence,
  },
}

const languageOptions = {
  parser: babelParser,
  parserOptions: {
    requireConfigFile: false,
    babelOptions: {
      configFile: false,
      babelrc: false,
      plugins: [['@babel/plugin-syntax-typescript', { isTSX: true, allExtensions: true }]],
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
}

/**
 * The fence config over the arm folders under `root` (a path relative to the
 * ESLint cwd). `frozen` folders are round-two arms: the wall-clock rule still
 * applies to them; the round-three rules do not. `thawed` names round-three
 * subfolders of a frozen arm (`mobx/pool`, POD-4565): every round-three rule
 * applies to them again, against the arm's `fence.json`, plus the import
 * fence (`thawed-import-fence`), which keeps them from importing the frozen
 * files the lint cannot see.
 */
export function fenceConfig({ root, frozen, thawed = [] }) {
  const files = [`${root}/**/*.ts`, `${root}/**/*.tsx`]
  const thawedConfig =
    thawed.length === 0
      ? []
      : [
          {
            files: thawed.flatMap((folder) => [`${root}/${folder}/**/*.ts`, `${root}/${folder}/**/*.tsx`]),
            languageOptions,
            plugins: { fence: plugin },
            rules: { 'fence/thawed-import-fence': ['error', { thawed }] },
          },
        ]
  return [
    {
      files,
      languageOptions,
      plugins: { fence: plugin },
      rules: { 'fence/no-wall-clock': 'error' },
    },
    {
      files,
      ignores: [
        ...frozen.map((folder) => `${root}/${folder}/**`),
        ...thawed.map((folder) => `!${root}/${folder}/**`),
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
      languageOptions,
      plugins: { fence: plugin },
      rules: {
        'fence/arm-manifest': 'error',
        'fence/no-table-walk': 'error',
        'fence/no-store-in-component': 'error',
        'fence/row-component-module-scope': 'error',
        'fence/no-hidden-state': 'error',
      },
    },
    ...thawedConfig,
  ]
}
