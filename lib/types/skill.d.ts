/**
 * Local-checkout skill provider for the DeepSeek Harness skill seam. Each
 * GitLab skill source is `git clone`d to a local directory; this provider
 * scans that checkout for `SKILL.md` directory bundles and registers them on
 * `ctx.skills`. Reads are local filesystem reads (fast, offline-capable) — the
 * sync step (`git clone`/`git pull`) owns freshness, and writes (commit/push)
 * belong to the separate management tools, not this read-only seam.
 * @module @lim324/dsh-gitlab/src/skill
 */
import type { Context } from '@deepseek-ai/cordis';
import { type SkillProvider } from '@deepseek-ai/dsh-skill';
/** Configuration for one local-checkout skill provider. */
export interface LocalSkillConfig {
    /** Absolute directory to scan for `SKILL.md` bundles. */
    localRoot: string;
    /** Discovery rank; lower ranks win duplicate skill names. */
    rank: number;
    /** Prompt-visible origin label carried by every candidate. */
    source: string;
    /** Provider name registered on `ctx.skills`. */
    providerName: string;
}
/**
 * Build a local-checkout `SkillProvider`. `list()` scans the checkout for
 * `SKILL.md` bundles and reads their frontmatter; `get()` re-reads one file's
 * full body by its opaque locator.
 */
export declare function createLocalSkillProvider(config: LocalSkillConfig, ctx: Context): SkillProvider;
