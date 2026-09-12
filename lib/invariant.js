//#region src/invariant.ts
const PACKAGE_NAME = "@lim324/dsh-gitlab";
/** Cordis companion plugin name. */
const name = "dsh-gitlab-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the host half owns no mutable state that can outlive
* its fiber — the snapshot, the GitLab client, and the poll timer are
* fiber-local (the timer dies through the fiber effect), and its only
* contributions are the two routes registered through `ctx.webServer`,
* whose registration-disposal symmetry the webserver companion already
* probes on every fiber teardown. The client half runs in the browser,
* outside any host invariant's reach.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
