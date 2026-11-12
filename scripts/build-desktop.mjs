import { build } from 'esbuild'

await build({ entryPoints: ['electron/updater.cjs'], outfile: 'dist/desktop/updater.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, legalComments: 'inline' })