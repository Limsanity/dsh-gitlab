/**
 * Minimal same-origin fence for the plugin's own HTTP routes, mirroring the
 * harness trust fence's observable checks (loopback Host, cross-site
 * rejection, Origin equality). The routes are loopback-only by design: this
 * plugin configures no trusted-host list, so anything beyond loopback is
 * refused. Kept local because `isTrustedApiRequest` is not exported from the
 * published connection package.
 * @module @lim324/dsh-gitlab/src/fence
 */

import type { IncomingMessage } from 'node:http'

/** Whether a request reached us over a loopback authority with no cross-site markers. */
export function isTrustedLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
