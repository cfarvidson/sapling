import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@octokit/rest', () => import('../__mocks__/@octokit/rest.js'));

import { __resetMock, __state } from '../__mocks__/@octokit/rest.js';
import { listOrgRepos } from '../../src/github.js';

describe('listOrgRepos', () => {
  beforeEach(() => {
    __resetMock();
  });

  it('passes the token to Octokit and the org to paginate', async () => {
    __state.repos = [
      {
        name: 'r1',
        clone_url: 'https://github.com/org/r1.git',
        default_branch: 'main',
        archived: false,
      },
    ];
    await listOrgRepos('ghp_test', 'my-org', 'all');
    expect(__state.lastTokenSeen).toBe('ghp_test');
    expect(__state.lastOrgSeen).toBe('my-org');
  });

  it('filters out archived repos', async () => {
    __state.repos = [
      { name: 'live', clone_url: 'u1', default_branch: 'main', archived: false },
      { name: 'dead', clone_url: 'u2', default_branch: 'main', archived: true },
    ];
    const out = await listOrgRepos('t', 'org', 'all');
    expect(out.map((r) => r.name)).toEqual(['live']);
  });

  it('propagates Octokit errors', async () => {
    __state.shouldThrow = new Error('rate limited');
    await expect(listOrgRepos('t', 'org', 'all')).rejects.toThrow('rate limited');
  });
});
