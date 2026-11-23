import { fileURLToPath } from 'node:url'

// Script audits and their child processes address paths from the repository.
// Turbo launches this package in scripts/, while focused/root runs start at
// the repository. Give both the same working directory before importing tests.
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
