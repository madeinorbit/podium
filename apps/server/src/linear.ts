/**
 * Minimal Linear GraphQL client for the superagent's ticket tools. Raw fetch —
 * three queries don't justify an SDK. All functions throw on HTTP/GraphQL
 * errors; the tool layer turns that into a tool-result string.
 */

const ENDPOINT = 'https://api.linear.app/graphql'

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`linear ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (data.errors?.length)
    throw new Error(`linear: ${data.errors.map((e) => e.message).join('; ')}`)
  if (!data.data) throw new Error('linear: empty response')
  return data.data
}

export interface LinearIssue {
  identifier: string
  title: string
  state: string
  assignee?: string
  url: string
}

export async function searchIssues(apiKey: string, query: string): Promise<LinearIssue[]> {
  type R = {
    searchIssues: {
      nodes: {
        identifier: string
        title: string
        url: string
        state?: { name?: string }
        assignee?: { displayName?: string }
      }[]
    }
  }
  const r = await gql<R>(
    apiKey,
    `query($term: String!) {
       searchIssues(term: $term, first: 15) {
         nodes { identifier title url state { name } assignee { displayName } }
       }
     }`,
    { term: query },
  )
  return r.searchIssues.nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    state: n.state?.name ?? 'unknown',
    ...(n.assignee?.displayName ? { assignee: n.assignee.displayName } : {}),
  }))
}

export async function createIssue(
  apiKey: string,
  input: { teamKey: string; title: string; description?: string },
): Promise<LinearIssue> {
  type Teams = { teams: { nodes: { id: string; key: string }[] } }
  const teams = await gql<Teams>(apiKey, 'query { teams(first: 50) { nodes { id key } } }')
  const team = teams.teams.nodes.find((t) => t.key.toLowerCase() === input.teamKey.toLowerCase())
  if (!team) {
    throw new Error(
      `no team with key "${input.teamKey}" — available: ${teams.teams.nodes.map((t) => t.key).join(', ')}`,
    )
  }
  type Created = {
    issueCreate: {
      issue: { identifier: string; title: string; url: string; state?: { name?: string } }
    }
  }
  const r = await gql<Created>(
    apiKey,
    `mutation($teamId: String!, $title: String!, $description: String) {
       issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
         issue { identifier title url state { name } }
       }
     }`,
    { teamId: team.id, title: input.title, description: input.description ?? null },
  )
  const issue = r.issueCreate.issue
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? 'created',
  }
}

export async function moveIssue(
  apiKey: string,
  input: { issueId: string; stateName: string },
): Promise<LinearIssue> {
  type Found = {
    issue: { id: string; identifier: string; title: string; url: string; team: { id: string } }
  }
  const found = await gql<Found>(
    apiKey,
    'query($id: String!) { issue(id: $id) { id identifier title url team { id } } }',
    { id: input.issueId },
  )
  type States = { workflowStates: { nodes: { id: string; name: string; team: { id: string } }[] } }
  const states = await gql<States>(
    apiKey,
    'query { workflowStates(first: 100) { nodes { id name team { id } } } }',
  )
  const state = states.workflowStates.nodes.find(
    (s) =>
      s.team.id === found.issue.team.id && s.name.toLowerCase() === input.stateName.toLowerCase(),
  )
  if (!state) {
    const options = states.workflowStates.nodes
      .filter((s) => s.team.id === found.issue.team.id)
      .map((s) => s.name)
      .join(', ')
    throw new Error(`no state "${input.stateName}" on that team — options: ${options}`)
  }
  await gql(
    apiKey,
    `mutation($id: String!, $stateId: String!) {
       issueUpdate(id: $id, input: { stateId: $stateId }) { success }
     }`,
    { id: found.issue.id, stateId: state.id },
  )
  return {
    identifier: found.issue.identifier,
    title: found.issue.title,
    url: found.issue.url,
    state: state.name,
  }
}
