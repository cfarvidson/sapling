import { vi } from 'vitest';

export type FakeRepo = {
  name: string;
  clone_url: string;
  default_branch: string;
  archived: boolean;
};

export const __state = {
  repos: [] as FakeRepo[],
  shouldThrow: undefined as Error | undefined,
  lastTokenSeen: undefined as string | undefined,
  lastOrgSeen: undefined as string | undefined,
};

export function __resetMock() {
  __state.repos = [];
  __state.shouldThrow = undefined;
  __state.lastTokenSeen = undefined;
  __state.lastOrgSeen = undefined;
}

export const Octokit = vi.fn().mockImplementation((opts: { auth?: string } = {}) => {
  __state.lastTokenSeen = opts.auth;
  return {
    paginate: vi.fn(async (_endpoint: unknown, params: { org: string; per_page?: number }) => {
      __state.lastOrgSeen = params.org;
      if (__state.shouldThrow) throw __state.shouldThrow;
      return [...__state.repos];
    }),
    rest: {
      repos: {
        listForOrg: vi.fn(),
      },
    },
  };
});
