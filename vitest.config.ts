import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Config resolution reads real environment variables and the real home
    // directory, so tests must not share a process.
    isolate: true,
    // The keystore tests run scrypt at N=131072, which is deliberately slow,
    // that is the whole point of the parameter. Five of them take about five
    // seconds on an idle laptop and comfortably exceed vitest's 5 s default on
    // a loaded machine or a shared CI runner. Observed failing exactly once,
    // under four concurrent network calls; raised rather than left to be
    // rediscovered as a flake in somebody's pull request.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/abi/**', 'src/cli.ts'],
    },
  },
})
