const page = 'pageInfo { hasNextPage endCursor }';
const quota = 'rateLimit { cost limit remaining resetAt }';
const actor = 'author { __typename login } authorAssociation';
const comment = `id body url createdAt updatedAt ${actor}`;
const indexFields = `id number title body url state isDraft headRefOid baseRefName updatedAt createdAt mergedAt mergeCommit { oid } mergeable author { login } repository { nameWithOwner } labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } }`;
const pr = (selection: string) => `repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${selection} } }`;
const vars = '$owner:String!,$repo:String!,$number:Int!,$cursor:String';

export const queries = {
  index: `query Index($author:String!,$cursor:String) { user(login:$author) { pullRequests(first:100,after:$cursor) { totalCount nodes { ${indexFields} } ${page} } } ${quota} }`,
  indexOpen: `query IndexOpen($author:String!,$cursor:String) { user(login:$author) { pullRequests(states:[OPEN],first:100,after:$cursor) { totalCount nodes { ${indexFields} } ${page} } } ${quota} }`,
  meta: `query Meta($owner:String!,$repo:String!,$number:Int!) { ${pr(indexFields)} ${quota} }`,
  comments: `query Comments(${vars}) { ${pr(`comments(first:100,after:$cursor) { nodes { ${comment} } ${page} }`)} ${quota} }`,
  reviews: `query Reviews(${vars}) { ${pr(`reviews(first:100,after:$cursor) { nodes { ${comment} state commit { oid } } ${page} }`)} ${quota} }`,
  threads: `query Threads(${vars}) { ${pr(`reviewThreads(first:100,after:$cursor) { nodes { id isResolved isOutdated comments(first:100) { nodes { ${comment} outdated originalCommit { oid } replyTo { id } } ${page} } } ${page} }`)} ${quota} }`,
  threadComments: `query ThreadComments($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$cursor) { nodes { ${comment} outdated originalCommit { oid } replyTo { id } } ${page} } } } ${quota} }`,
  commits: `query Commits(${vars}) { ${pr(`commits(first:100,after:$cursor) { nodes { commit { oid message authoredDate author { email user { login } } } } ${page} }`)} ${quota} }`,
  timeline: `query Timeline(${vars}) { ${pr(`timelineItems(first:100,after:$cursor,itemTypes:[CROSS_REFERENCED_EVENT,CLOSED_EVENT,REOPENED_EVENT,HEAD_REF_FORCE_PUSHED_EVENT,MERGED_EVENT]) { nodes { __typename ... on CrossReferencedEvent { id createdAt actor { login } source { __typename ... on Issue { id number url title body state updatedAt repository { nameWithOwner } } ... on PullRequest { id number url title body state updatedAt mergedAt repository { nameWithOwner } } } } ... on ClosedEvent { id createdAt actor { login } } ... on ReopenedEvent { id createdAt actor { login } } ... on HeadRefForcePushedEvent { id createdAt actor { login } } ... on MergedEvent { id createdAt actor { login } } } ${page} }`)} ${quota} }`,
  checks: `query Checks($owner:String!,$repo:String!,$number:Int!,$head:String!,$cursor:String) { repository(owner:$owner,name:$repo) { object(expression:$head) { ... on Commit { oid statusCheckRollup { contexts(first:100,after:$cursor) { nodes { __typename ... on CheckRun { id name status conclusion detailsUrl isRequired(pullRequestNumber:$number) } ... on StatusContext { id context state targetUrl isRequired(pullRequestNumber:$number) } } ${page} } } } } } ${quota} }`,
  labels: `query Labels(${vars}) { ${pr(`labels(first:100,after:$cursor) { nodes { name } ${page} }`)} ${quota} }`,
  relation: `query Relation($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { issueOrPullRequest(number:$number) { __typename ... on Issue { id number url title body state updatedAt repository { nameWithOwner } } ... on PullRequest { id number url title body state updatedAt mergedAt repository { nameWithOwner } } } } ${quota} }`,
  relationComments: `query RelationComments($id:ID!,$cursor:String) { node(id:$id) { ... on Issue { comments(first:100,after:$cursor) { nodes { ${comment} } ${page} } } ... on PullRequest { comments(first:100,after:$cursor) { nodes { ${comment} } ${page} } } } ${quota} }`,
} as const;
export type QueryName = keyof typeof queries;

export type BatchKind = 'preflight' | 'details' | 'final' | 'relation' | 'relationComments';
export type BatchTarget = { owner?: string; repo?: string; number?: number; head?: string; id?: string };
// Extract selections only from the fixed, audited registry above. External input
// always remains in GraphQL variables, never in the document or alias names.
const bodyOf = (name: QueryName) => queries[name].slice(queries[name].indexOf('{') + 1, queries[name].lastIndexOf(quota)).trim();
const fieldsOf = (name: QueryName) => bodyOf(name).match(/pullRequest\(number:\$number\) \{ ([\s\S]*) \} \}$/)![1];
const detailFields = (['comments', 'reviews', 'threads', 'commits', 'timeline'] as const).map(fieldsOf).join(' ').replaceAll('first:100', 'first:20').replaceAll('after:$cursor', 'after:null');
const batchBodies = {
  preflight: bodyOf('meta'),
  details: pr(detailFields),
  final: bodyOf('checks').replace('object(expression:', `pullRequest(number:$number) { ${indexFields} } object(expression:`).replaceAll('after:$cursor', 'after:null'),
  relation: bodyOf('relation'),
  relationComments: bodyOf('relationComments').replaceAll('first:100', 'first:20').replaceAll('after:$cursor', 'after:null'),
};
const types: Record<string, string> = { owner: 'String!', repo: 'String!', number: 'Int!', head: 'String!', id: 'ID!' };
export function batchDocument(kind: BatchKind, targets: BatchTarget[]) {
  if (!Object.hasOwn(batchBodies, kind)) throw new Error('Unregistered batch type');
  const body = batchBodies[kind], variables: Record<string, string | number | null> = {}, declarations: string[] = [];
  const fields = targets.map((target, index) => {
    const replaced = body.replace(/\$(\w+)/g, (_match, key: keyof BatchTarget) => {
      const variable = `${key}${index}`;
      if (!Object.hasOwn(variables, variable)) {
        const value = target[key];
        if (key === 'number' ? !Number.isSafeInteger(value) || Number(value) <= 0 : typeof value !== 'string' || !value) throw new Error('Invalid batch target');
        variables[variable] = value!; declarations.push(`$${variable}:${types[key]}`);
      }
      return `$${variable}`;
    });
    return `p${index}: ${replaced}`;
  });
  return { query: `query Batch_${kind}(${declarations.join(',')}) { ${fields.join(' ')} ${quota} }`, variables };
}
