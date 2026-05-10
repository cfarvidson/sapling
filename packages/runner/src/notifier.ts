export interface AwaitingInputItem {
  id: number;
  title: string;
  updated_at: string;
}

export interface NagDeps {
  items: AwaitingInputItem[];
  ntfyUrl: string | null;
  nagAgeMs: number;
  nagRepeatMs: number;
  lastNotified: Map<number, Date>;
  fetchImpl?: typeof fetch;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface NagResult {
  count: number;
  oldestAgeMs: number;
  nagged: number;
}

export async function nagAwaitingInput(deps: NagDeps): Promise<NagResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (deps.items.length === 0) {
    return { count: 0, oldestAgeMs: 0, nagged: 0 };
  }

  let oldestAgeMs = 0;
  for (const it of deps.items) {
    const age = now.getTime() - new Date(it.updated_at).getTime();
    if (age > oldestAgeMs) oldestAgeMs = age;
  }

  if (!deps.ntfyUrl) {
    return { count: deps.items.length, oldestAgeMs, nagged: 0 };
  }

  let nagged = 0;
  for (const it of deps.items) {
    const age = now.getTime() - new Date(it.updated_at).getTime();
    if (age < deps.nagAgeMs) continue;
    const last = deps.lastNotified.get(it.id);
    if (last && now.getTime() - last.getTime() < deps.nagRepeatMs) continue;

    const ageHuman = formatAge(age);
    const body = `Sapling work item #${it.id} has been awaiting input for ${ageHuman}: ${it.title}\nRun /sapling:human ${it.id} to answer.`;
    try {
      const res = await fetchImpl(deps.ntfyUrl, {
        method: 'POST',
        headers: {
          Title: 'Sapling: awaiting input',
          Tags: 'warning',
          Click: `sapling://human/${it.id}`,
        },
        body,
      });
      if (!res.ok) {
        deps.log?.('notify_error', { id: it.id, status: res.status });
        continue;
      }
      deps.lastNotified.set(it.id, now);
      nagged += 1;
    } catch (err) {
      deps.log?.('notify_error', { id: it.id, err: String(err) });
    }
  }

  return { count: deps.items.length, oldestAgeMs, nagged };
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
