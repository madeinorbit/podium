import { afterEach, beforeEach } from 'vitest'
import { assertHermeticStateDir } from './test-hermetic-state-guard'

beforeEach(() => assertHermeticStateDir())
afterEach(() => assertHermeticStateDir())
