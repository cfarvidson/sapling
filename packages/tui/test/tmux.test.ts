import { describe, expect, it } from 'vitest';
import { findWorkWindowName, type TmuxWindow } from '../src/tmux.js';

const w = (name: string): TmuxWindow => ({ id: `@${name}`, name });

describe('findWorkWindowName', () => {
  it('returns null when no window matches', () => {
    expect(findWorkWindowName([w('runner'), w('tui')], 42)).toBeNull();
  });

  it('finds the legacy un-suffixed work-<id>', () => {
    expect(findWorkWindowName([w('work-42'), w('runner')], 42)).toBe('work-42');
  });

  it('finds the status-suffixed work-<id>:<status>', () => {
    expect(findWorkWindowName([w('work-42:claimed'), w('tui')], 42)).toBe('work-42:claimed');
  });

  it('prefers the suffixed form when both exist', () => {
    expect(findWorkWindowName([w('work-42'), w('work-42:claimed')], 42)).toBe('work-42:claimed');
  });

  it('does not cross-match other work ids', () => {
    expect(findWorkWindowName([w('work-420:claimed')], 42)).toBeNull();
  });
});
