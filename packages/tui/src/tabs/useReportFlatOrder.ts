import { useEffect, useRef } from 'react';

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Notify the parent about the current cursor flat-order, but only when the
 * contents change. Each MCP poll returns a fresh array reference even when
 * ids are unchanged; without this guard we'd setState every poll → App
 * re-renders → React warns about max update depth.
 */
export function useReportFlatOrder(
  flatOrder: readonly number[],
  report: (ids: number[]) => void,
): void {
  const last = useRef<readonly number[]>([]);
  useEffect(() => {
    if (arraysEqual(last.current, flatOrder)) return;
    last.current = flatOrder;
    report([...flatOrder]);
  }, [flatOrder, report]);
}
