import { defineConfig } from 'vitest/config'

// Harness packages resolve from this tree's own node_modules, which
// tools/hook-host-deps.sh points at the 0.2.0 core install tree
// (~/dsh-020/node_modules/@deepseek-ai) — the same artifacts a link-mounted
// instance loads at runtime, so tests and production share one Cordis copy.
//
// The alias block that used to live here pointed at the pre-migration source
// checkout ../../github/deepseek-harness. That checkout no longer exists, so
// every alias dangled: any spec importing Cordis (gitlab.spec.ts,
// skill.spec.ts) failed to LOAD and was dropped from the run rather than
// failing loudly, hiding the two specs that cover real Loader composition.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
