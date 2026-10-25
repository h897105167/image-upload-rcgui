import esbuild from 'esbuild'

const prod = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands', '@codemirror/language', '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight', '@lezer/lr'],
  format: 'cjs',
  target: 'es2022',
  outfile: 'main.js',
  minify: prod,
  sourcemap: !prod,
  logLevel: 'info',
})

if (watch) {
  await context.watch()
} else {
  await context.rebuild()
  await context.dispose()
}
