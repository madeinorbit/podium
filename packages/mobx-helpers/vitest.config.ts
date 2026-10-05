import { defineConfig } from 'vitest/config'
import { createPackageVitestConfig } from '../../scripts/package-vitest-config'

const config = createPackageVitestConfig('packages/mobx-helpers')
export default defineConfig({ ...config, test: { ...config.test, passWithNoTests: false } })
