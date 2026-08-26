import { defineConfig, type Options } from 'tsup'

const shared: Options = {
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  // Dependencies stay external: the package is installed, not vendored. Only
  // our own sources are bundled, which keeps `dist/` readable and auditable.
  skipNodeModulesBundle: true,
}

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli.ts', mcp: 'src/mcp.ts' },
    clean: true,
    // Only the executables get a shebang. Emitting one into the library entry
    // would leave a stray directive in a file nothing ever executes.
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    dts: true,
  },
])
