import { JSDOM } from 'jsdom'
import { populateGlobal } from 'vitest/runtime'

// Vitest's built-in jsdom environment enables runScripts: 'dangerously'. With
// jsdom 30 + Bun that creates a VM window whose EventTarget fails the WebIDL
// receiver check before tests collect. Sanitizer tests need parsing/traversal,
// not execution of scripts in HTML. Use jsdom's default inert window instead;
// do not patch DOM methods or DOMPurify to make the assertions pass.
/** @type {import('vitest/runtime').Environment} */
export default {
  name: 'jsdom-sanitizer',
  viteEnvironment: 'client',
  setup(global) {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'http://localhost:3000' })
    const { keys, originals } = populateGlobal(global, dom.window, { bindFunctions: true })
    return {
      teardown() {
        dom.window.close()
        for (const key of keys) delete global[key]
        for (const [key, descriptor] of originals) {
          Object.defineProperty(global, key, descriptor)
        }
      },
    }
  },
}
