import { afterEach, beforeEach } from 'bun:test'
import { assertHermeticStateDir } from './test-hermetic-state-guard'

beforeEach(() => assertHermeticStateDir())
afterEach(() => assertHermeticStateDir())
