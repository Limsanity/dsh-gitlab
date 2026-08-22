/**
 * Local-checkout skill provider coverage: scans a directory of `SKILL.md`
 * bundles and loads their bodies, matching the frontmatter contract of
 * `dsh-skill-filesystem`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { createLocalSkillProvider } from '../src/skill.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function skill(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: does ${name}\n${extra}---\n# ${name}\n\nbody of ${name}\n`
}

async function checkout(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gitlab-skill-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, 'skills', path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
  }
  return join(root, 'skills')
}

function makeProvider(localRoot: string): ReturnType<typeof createLocalSkillProvider> {
  return createLocalSkillProvider({
    localRoot, rank: 250, source: 'gitlab', providerName: 'gitlab:test',
  }, new Context())
}

/** Narrow the provider's list result to its candidate array. */
function candidatesOf(result: readonly SkillCandidate[] | SkillProviderObservation): readonly SkillCandidate[] {
  return 'candidates' in result ? result.candidates : result
}

describe('createLocalSkillProvider', () => {
  it('lists directory-bundle skills and loads their bodies', async () => {
    const localRoot = await checkout({
      'foo/SKILL.md': skill('foo', 'whenToUse: for foo things\n'),
      'bar/SKILL.md': skill('bar'),
    })
    const provider = makeProvider(localRoot)

    const candidates = candidatesOf(await provider.list({}))

    expect(candidates.map(candidate => candidate.name).sort()).toEqual(['bar', 'foo'])
    const foo = candidates.find(candidate => candidate.name === 'foo')!
    expect(foo.description).toBe('does foo')
    expect(foo.whenToUse).toBe('for foo things')
    expect(foo.rank).toBe(250)
    expect(foo.source).toBe('gitlab')
    expect(foo.invocation).toEqual({ modelInvocable: true, userInvocable: true })

    const loaded = await provider.get(foo, {})
    expect(loaded?.content).toContain('body of foo')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(localRoot, 'foo') })
  })

  it('normalizes the two invocation switches', async () => {
    const localRoot = await checkout({
      'a/SKILL.md': skill('a', 'disable-model-invocation: true\n'),
      'b/SKILL.md': skill('b', 'user-invocable: false\n'),
    })
    const provider = makeProvider(localRoot)

    const candidates = candidatesOf(await provider.list({}))
    const a = candidates.find(candidate => candidate.name === 'a')!
    const b = candidates.find(candidate => candidate.name === 'b')!

    expect(a.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    expect(b.invocation).toEqual({ modelInvocable: true, userInvocable: false })
  })

  it('skips files without valid frontmatter', async () => {
    const localRoot = await checkout({
      'good/SKILL.md': skill('good'),
      'bad/SKILL.md': '# no frontmatter\n',
    })
    const provider = makeProvider(localRoot)

    const candidates = candidatesOf(await provider.list({}))

    expect(candidates.map(candidate => candidate.name)).toEqual(['good'])
  })

  it('returns nothing for a missing checkout', async () => {
    const provider = makeProvider(join(tmpdir(), 'does-not-exist'))
    expect(candidatesOf(await provider.list({}))).toEqual([])
  })
})
