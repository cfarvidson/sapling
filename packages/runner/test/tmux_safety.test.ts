import { describe, expect, it } from 'vitest';
import { detectForeignWindows } from '../src/tmux_safety.js';

describe('detectForeignWindows', () => {
  it('returns nothing when there are no windows', () => {
    expect(detectForeignWindows([], [])).toEqual([]);
  });

  it('ignores non-work windows like runner and tui', () => {
    expect(detectForeignWindows(['runner', 'tui', 'spawn-3'], [])).toEqual([]);
  });

  it('flags work-<n> windows when own list is empty', () => {
    expect(detectForeignWindows(['runner', 'work-9'], [])).toEqual(['work-9']);
  });

  it('does not flag windows we own', () => {
    expect(detectForeignWindows(['work-9', 'work-12'], ['work-9', 'work-12'])).toEqual([]);
  });

  it('flags suffixed status-aware window names too', () => {
    expect(
      detectForeignWindows(['work-7:claimed', 'work-8:awaiting_input', 'work-9'], ['work-9']),
    ).toEqual(['work-7:claimed', 'work-8:awaiting_input']);
  });

  it('returns only the foreign subset when mixed with own names', () => {
    expect(
      detectForeignWindows(['runner', 'work-1', 'work-2:claimed', 'work-3'], ['work-2:claimed']),
    ).toEqual(['work-1', 'work-3']);
  });
});
