import { defineConfig } from 'tsdown'

// Browser bundle in the module-loader factory format the Web shell expects:
// window.__ModuleLoader__.load({ id, factory }). Platform modules (react and
// friends) stay external — the shell seeds them into the module table.
const ID = '@lim324/dsh-gitlab'

export default defineConfig({
  entry: ['src/client/index.tsx'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
