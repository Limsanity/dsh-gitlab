/**
 * Thin git command helpers for the skills sync surface: clone, pull, and
 * commit/push run through the `git` binary so the local skills checkout stays
 * a real repository. The GitLab token is embedded in the checkout's origin URL
 * so every later `pull`/`push` authenticates without a credential helper; the
 * checkout lives under the user's DSH home (like the settings token) and is
 * never committed or shared, so this is the same exposure class as the token
 * already stored in `settings.yaml`.
 * @module @lim324/dsh-gitlab/src/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Test hook: tests substitute a fake git runner; production never touches this. */
export const internals: { runGit?: (args: string[]) => Promise<string> } = {}

async function runGit(args: string[]): Promise<string> {
  if (internals.runGit !== undefined) return await internals.runGit(args)
  const { stdout } = await execFileAsync('git', args)
  return stdout
}

/** Inject an oauth2 token into an https clone URL. */
function authedUrl(url: string, token: string | undefined): string {
  if (token === undefined || token === '') return url
  const parsed = new URL(url)
  parsed.username = 'oauth2'
  parsed.password = token
  return parsed.toString().replace(/\/$/, '')
}

/**
 * Clone one repository shallowly to `dest`, keeping the token in the origin
 * URL so subsequent pulls and pushes authenticate.
 * @param cloneUrl - https clone URL (token-free).
 * @param token - optional GitLab token for private repositories.
 * @param dest - destination directory.
 */
export async function gitClone(cloneUrl: string, token: string | undefined, dest: string): Promise<void> {
  await runGit(['clone', '--depth', '1', authedUrl(cloneUrl, token), dest])
}

/** Fast-forward pull one existing checkout to its remote default branch. */
export async function gitPull(dest: string): Promise<void> {
  await runGit(['-C', dest, 'pull', '--ff-only'])
}

/**
 * Stage all changes, commit, and push in one existing checkout.
 * @param dest - the checkout directory.
 * @param message - commit message.
 */
export async function gitCommitPush(dest: string, message: string): Promise<void> {
  await runGit(['-C', dest, 'add', '-A'])
  await runGit(['-C', dest, 'commit', '-m', message])
  await runGit(['-C', dest, 'push', 'HEAD'])
}
