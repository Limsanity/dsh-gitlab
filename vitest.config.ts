import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Local development: harness packages resolve from the checkout's BUILT
// artifacts (lib/), so the whole test program shares one Cordis copy.
// Published consumption resolves the version ranges in package.json instead.
const repo = '../../github/deepseek-harness'
const alias: Record<string, string> = {
  '@deepseek-ai/cordis': fileURLToPath(new URL(`${repo}/vendor/cordis/lib/index.js`, import.meta.url)),
  '@deepseek-ai/schemastery': fileURLToPath(new URL(`${repo}/vendor/schemastery/lib/index.mjs`, import.meta.url)),
  '@deepseek-ai/cordis-plugin-loader': fileURLToPath(new URL(`${repo}/vendor/loader/lib/index.js`, import.meta.url)),
  '@deepseek-ai/cordis-plugin-include': fileURLToPath(new URL(`${repo}/vendor/include/lib/index.js`, import.meta.url)),
  '@deepseek-ai/dsh-invariants': fileURLToPath(new URL(`${repo}/packages/runtime-diagnostics/invariants/lib/index.js`, import.meta.url)),
  '@deepseek-ai/dsh-host-webserver': fileURLToPath(new URL(`${repo}/packages/host/webserver/lib/index.js`, import.meta.url)),
  '@deepseek-ai/dsh-settings': fileURLToPath(new URL(`${repo}/packages/settings/settings/lib/index.js`, import.meta.url)),
  '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL(`${repo}/packages/client/ui-primitives/lib/index.js`, import.meta.url)),
}

export default defineConfig({
  resolve: { alias },
  server: {
    fs: {
      // The aliased harness artifacts live outside this project's root.
      allow: ['.', fileURLToPath(new URL(repo, import.meta.url))],
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
