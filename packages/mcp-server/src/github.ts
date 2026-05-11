import { Octokit } from '@octokit/rest';

export interface DiscoveredRepo {
  name: string;
  clone_url: string;
  default_branch: string;
  archived: boolean;
}

export async function listOrgRepos(
  token: string,
  org: string,
  visibility: 'all' | 'public' | 'private',
): Promise<DiscoveredRepo[]> {
  const octokit = new Octokit({ auth: token });
  const all = (await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: visibility === 'all' ? 'all' : visibility,
  })) as DiscoveredRepo[];
  return all.filter((r) => !r.archived);
}
