/**
 * Local-checkout skill provider for the DeepSeek Harness skill seam. Each
 * GitLab skill source is `git clone`d to a local directory; this provider
 * scans that checkout for `SKILL.md` directory bundles and registers them on
 * `ctx.skills`. Reads are local filesystem reads (fast, offline-capable) — the
 * sync step (`git clone`/`git pull`) owns freshness, and writes (commit/push)
 * belong to the separate management tools, not this read-only seam.
 * @module @lim324/dsh-gitlab/src/skill
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

/** Configuration for one local-checkout skill provider. */
export interface LocalSkillConfig {
  /** Absolute directory to scan for `SKILL.md` bundles. */
  localRoot: string
  /** Discovery rank; lower ranks win duplicate skill names. */
  rank: number
  /** Prompt-visible origin label carried by every candidate. */
  source: string
  /** Provider name registered on `ctx.skills`. */
  providerName: string
}

/** Opaque locator carried by a candidate back to `get()`. */
interface SkillLocator {
  path: string
  directory: string
}

/** The frontmatter and body of one parsed skill file. */
interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  content: string
}

const SKILL_FILE = 'SKILL.md'

/**
 * Extract the YAML frontmatter block from a skill file. Returns the parsed
 * data map plus the remaining body, or undefined when the file has no
 * frontmatter or the block is malformed.
 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const closing = findClosingFrontmatter(raw, firstLineEnd + 1)
  if (closing === undefined) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(raw.slice(firstLineEnd + 1, closing.start))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

/** Find the closing `---` line after the frontmatter opener. */
function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/** Read a non-empty string frontmatter field. */
function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize the two invocation switches, matching `dsh-skill-filesystem`. */
function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** Parse a boolean frontmatter field accepting YAML and string spellings. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Parse one skill file into its normalized fields, returning undefined for a
 * file missing required frontmatter or carrying an invalid name or policy.
 */
function parseSkill(raw: string, ctx: Context): ParsedSkill | undefined {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) return undefined
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined) return undefined
  if (!isSkillName(name)) return undefined
  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(parsed.data)
  } catch (error) {
    ctx.logger.warn(`gitlab skill "${name}" ignored: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const whenToUse = stringField(parsed.data, 'whenToUse')
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation,
    content: parsed.body.trim(),
  }
}

/** Recursively collect every `SKILL.md` path under a directory. */
async function findSkillFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A missing or unreadable checkout yields no skills rather than failing.
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name === SKILL_FILE) found.push(full)
    }
  }
  await walk(root)
  return found
}

/**
 * Build a local-checkout `SkillProvider`. `list()` scans the checkout for
 * `SKILL.md` bundles and reads their frontmatter; `get()` re-reads one file's
 * full body by its opaque locator.
 */
export function createLocalSkillProvider(config: LocalSkillConfig, ctx: Context): SkillProvider {
  return {
    name: config.providerName,
    async list(options: SkillLookupOptions): Promise<SkillCandidate[]> {
      options.signal?.throwIfAborted()
      const files = await findSkillFiles(config.localRoot)
      const candidates: SkillCandidate[] = []
      for (const file of files) {
        options.signal?.throwIfAborted()
        let raw: string
        try {
          raw = await readFile(file, 'utf8')
        } catch (error) {
          ctx.logger.warn(`gitlab skill ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const parsed = parseSkill(raw, ctx)
        if (parsed === undefined) continue
        const directory = dirname(file)
        candidates.push({
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
          invocation: parsed.invocation,
          source: config.source,
          provider: config.providerName,
          rank: config.rank,
          locator: { path: file, directory } satisfies SkillLocator,
          resourceBase: { kind: 'directory', path: directory },
        })
      }
      return candidates
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      options.signal?.throwIfAborted()
      const locator = candidate.locator as SkillLocator
      let raw: string
      try {
        raw = await readFile(locator.path, 'utf8')
      } catch {
        return undefined
      }
      const parsed = parseSkill(raw, ctx)
      // A renamed or rewritten file whose frontmatter no longer names this
      // candidate is no longer loadable.
      if (parsed === undefined || parsed.name !== candidate.name) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: parsed.invocation,
        source: candidate.source,
        provider: config.providerName,
        resourceBase: { kind: 'directory', path: locator.directory },
        content: parsed.content,
        path: locator.path,
      }
    },
  }
}
