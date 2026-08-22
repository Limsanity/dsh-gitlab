/**
 * GitlabApi unit coverage for the group-project listing the skill sync uses.
 */

import { describe, expect, it } from 'vitest'
import { GitlabApi } from '../src/gitlab.ts'

function api(respond: (url: string) => unknown): GitlabApi {
  return new GitlabApi({
    baseUrl: 'https://gitlab.com/api/v4',
    fetchImpl: async (input) => {
      const body = respond(String(input))
      return { ok: true, status: 200, async text() { return JSON.stringify(body) } } as Response
    },
  })
}

describe('GitlabApi.listGroupProjects', () => {
  it('lists projects with include_subgroups and projects the rows', async () => {
    let seen = ''
    const client = api((url) => {
      seen = url
      return [{ name: 'skill-a', path_with_namespace: 'g/sub/skill-a' }]
    })
    const rows = await client.listGroupProjects('g/sub', true)

    expect(rows).toEqual([{ name: 'skill-a', pathWithNamespace: 'g/sub/skill-a' }])
    expect(seen).toContain('/groups/g%2Fsub/projects?')
    expect(seen).toContain('include_subgroups=true')
  })

  it('defaults include_subgroups to true', async () => {
    let seen = ''
    api((url) => { seen = url; return [] }).listGroupProjects('g', undefined)
    expect(seen).toContain('include_subgroups=true')
  })
})
