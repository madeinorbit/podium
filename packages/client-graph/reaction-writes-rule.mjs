/** A reaction may dispatch effects, but must not maintain a computed's
 * observable collection. Derive that collection, or file it in the feed action. */
export const noReactionWrites = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { write: 'Reaction effect writes observable {{target}}. Use a computed or the applying action.' },
  },
  create(context) {
    const source = context.sourceCode
    const reactions = new Set(), observables = new Set(), namespaces = new Set()
    const targets = new Set(), aliases = [], functions = new Map(), calls = []
    const bindings = new WeakMap()
    let nextBinding = 0
    const binding = (node) => {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name)
        if (!variable) continue
        if (!bindings.has(variable)) bindings.set(variable, ++nextBinding)
        return `${node.name}@${bindings.get(variable)}`
      }
      return node.name
    }
    const owner = (node) => {
      for (let current = node; current; current = current.parent) {
        if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression') return `this@${current.range[0]}`
      }
      return 'this'
    }
    const unwrap = (node) => {
      while (node && ['TSAsExpression', 'TSNonNullExpression', 'ChainExpression'].includes(node.type)) node = node.expression
      return node
    }
    const name = (input) => {
      const node = unwrap(input)
      if (!node) return undefined
      if (node.type === 'Identifier') return binding(node)
      if (node.type === 'ThisExpression') return owner(node)
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        const key = node.computed ? node.property.value : node.property.name
        const object = name(node.object)
        return object && typeof key === 'string' ? `${object}.${key}` : undefined
      }
      return undefined
    }
    const children = (node) => (source.visitorKeys[node.type] ?? []).flatMap((key) => {
      const value = node[key]
      return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []
    })
    const isObservable = (node) => {
      node = unwrap(node)
      if (node?.type !== 'CallExpression') return false
      const callee = name(node.callee)
      return [...observables].some((alias) => callee === alias || callee?.startsWith(`${alias}.`)) ||
        [...namespaces].some((alias) => callee === `${alias}.observable` || callee?.startsWith(`${alias}.observable.`))
    }
    const define = (target, input) => {
      const value = unwrap(input)
      if (!target || !value) return
      if (isObservable(value)) targets.add(target)
      else if (name(value)) aliases.push([target, name(value)])
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)) functions.set(target, value)
    }
    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'mobx') return
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') namespaces.add(name(spec.local))
          if (spec.imported?.name === 'reaction') reactions.add(name(spec.local))
          if (spec.imported?.name === 'observable') observables.add(name(spec.local))
        }
      },
      VariableDeclarator(node) { define(name(node.id), node.init) },
      PropertyDefinition(node) { define(`${owner(node)}.${node.key.name}`, node.value) },
      ClassProperty(node) { define(`${owner(node)}.${node.key.name}`, node.value) },
      AssignmentExpression(node) { define(name(node.left), node.right) },
      FunctionDeclaration(node) { if (node.id) functions.set(name(node.id), node) },
      MethodDefinition(node) { functions.set(`${owner(node)}.${node.key.name}`, node.value) },
      CallExpression(node) { calls.push(node) },
      'Program:exit'() {
        for (let changed = true; changed;) {
          changed = false
          for (const [target, value] of aliases) if (targets.has(value) && !targets.has(target)) {
            targets.add(target); changed = true
          }
        }
        for (const call of calls) {
          const callee = name(call.callee)
          if (!reactions.has(callee) && ![...namespaces].some((alias) => callee === `${alias}.reaction`)) continue
          const seen = new Set()
          const writes = (input) => {
            const node = unwrap(input)
            if (!node || seen.has(node)) return undefined
            seen.add(node)
            if (node.type === 'Identifier') return writes(functions.get(name(node)))
            if (node.type === 'CallExpression') {
              const method = unwrap(node.callee)
              if (method?.type === 'MemberExpression') {
                const operation = method.computed ? method.property.value : method.property.name
                const target = name(method.object)
                if (['set', 'add', 'delete'].includes(operation) && targets.has(target)) return target
              }
              const nested = writes(functions.get(name(node.callee)))
              if (nested) return nested
            }
            for (const child of children(node)) {
              const found = writes(child)
              if (found) return found
            }
            return undefined
          }
          const target = writes(call.arguments[1])
          if (target) context.report({ node: call, messageId: 'write', data: { target } })
        }
      },
    }
  },
}
