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
/** Test hook: tests substitute a fake git runner; production never touches this. */
export declare const internals: {
    runGit?: (args: string[], opts: {
        env: NodeJS.ProcessEnv;
        stdio: [string, string, string];
    }) => Promise<string>;
};
/**
 * Clone one repository shallowly to `dest`, keeping the token in the origin
 * URL so subsequent pulls and pushes authenticate.
 * @param cloneUrl - https clone URL (token-free).
 * @param token - optional GitLab token for private repositories.
 * @param dest - destination directory.
 */
export declare function gitClone(cloneUrl: string, token: string | undefined, dest: string): Promise<void>;
/** Fast-forward pull one existing checkout to its remote default branch. */
export declare function gitPull(dest: string): Promise<void>;
/**
 * Stage all changes, commit, and push in one existing checkout.
 * @param dest - the checkout directory.
 * @param message - commit message.
 */
export declare function gitCommitPush(dest: string, message: string): Promise<void>;
/** Read a checkout's origin URL (trimmed); throws when there is no origin. */
export declare function gitGetRemoteUrl(dest: string): Promise<string>;
/** Point a checkout's origin at `url`. */
export declare function gitSetRemoteUrl(dest: string, url: string): Promise<void>;
/**
 * Re-embed `token` into a checkout's origin URL when the stored token differs,
 * so a token rotation takes effect on existing checkouts without a re-clone.
 * No-op when the token is unset, the checkout has no origin, or the token is
 * unchanged.
 * @param dest - the checkout directory.
 * @param token - the current GitLab token.
 */
export declare function refreshOriginToken(dest: string, token: string | undefined): Promise<void>;
