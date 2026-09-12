/**
 * Package-owned invariant companion for `@lim324/dsh-gitlab`.
 * @module @lim324/dsh-gitlab/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "dsh-gitlab-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
