/**
 * git helper coverage: the command shapes clone/pull/commit/push run, with the
 * token injected only into the clone URL.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { gitClone, gitCommitPush, gitPull, internals, refreshOriginToken } from '../src/git.ts'

afterEach(() => {
  internals.runGit = undefined
})

interface CapturedRun {
  args: string[]
  env: NodeJS.ProcessEnv
}

function capture(): CapturedRun[] {
  const calls: CapturedRun[] = []
  internals.runGit = async (args, opts) => { calls.push({ args, env: opts.env }); return '' }
  return calls
}

function argsOf(calls: CapturedRun[]): string[][] {
  return calls.map(call => call.args)
}

describe('git helpers', () => {
  it('clones shallowly with an oauth2 token in the URL', async () => {
    const calls = capture()
    await gitClone('https://gitlab.com/group/repo.git', 'tok123', '/tmp/dest')
    expect(argsOf(calls)).toEqual([
      ['clone', '--depth', '1', 'https://oauth2:tok123@gitlab.com/group/repo.git', '/tmp/dest'],
    ])
  })

  it('clones without a token when none is provided', async () => {
    const calls = capture()
    await gitClone('https://gitlab.com/group/repo.git', undefined, '/tmp/dest')
    expect(argsOf(calls)[0]?.[3]).toBe('https://gitlab.com/group/repo.git')
  })

  it('pulls fast-forward only', async () => {
    const calls = capture()
    await gitPull('/tmp/dest')
    expect(argsOf(calls)).toEqual([['-C', '/tmp/dest', 'pull', '--ff-only']])
  })

  it('stages, commits, and pushes HEAD', async () => {
    const calls = capture()
    await gitCommitPush('/tmp/dest', 'update skill')
    expect(argsOf(calls)).toEqual([
      ['-C', '/tmp/dest', 'add', '-A'],
      ['-C', '/tmp/dest', 'commit', '-m', 'update skill'],
      ['-C', '/tmp/dest', 'push', 'HEAD'],
    ])
  })

  it('disables the interactive credential prompt so a missing token fails fast', async () => {
    const calls = capture()
    await gitClone('https://gitlab.com/group/repo.git', undefined, '/tmp/dest')
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('re-points the origin when the stored token differs', async () => {
    const calls: string[][] = []
    internals.runGit = async (args) => {
      calls.push(args)
      if (args[2] === 'remote') return 'https://oauth2:old@gitlab.com/group/repo.git'
      return ''
    }
    await refreshOriginToken('/tmp/dest', 'new')
    expect(calls).toEqual([
      ['-C', '/tmp/dest', 'remote', 'get-url', 'origin'],
      ['-C', '/tmp/dest', 'remote', 'set-url', 'origin', 'https://oauth2:new@gitlab.com/group/repo.git'],
    ])
  })

  it('leaves the origin unchanged when the token already matches', async () => {
    const calls: string[][] = []
    internals.runGit = async (args) => {
      calls.push(args)
      if (args[2] === 'remote') return 'https://oauth2:new@gitlab.com/group/repo.git'
      return ''
    }
    await refreshOriginToken('/tmp/dest', 'new')
    expect(calls).toEqual([['-C', '/tmp/dest', 'remote', 'get-url', 'origin']])
  })

  it('does nothing when no token is provided', async () => {
    const calls: string[][] = []
    internals.runGit = async (args) => { calls.push(args); return '' }
    await refreshOriginToken('/tmp/dest', undefined)
    expect(calls).toEqual([])
  })
})
