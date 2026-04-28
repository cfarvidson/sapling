import { describe, expect, it } from 'vitest';
import { AppError, errorToToolResult, mapPgError } from '../../src/errors.js';

describe('errors', () => {
  it('serializes AppError into a structured tool result with isError', () => {
    const err = new AppError('not_found', 'service id 42 not found');
    const result = errorToToolResult(err);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ error: { code: 'not_found', message: 'service id 42 not found' } }),
    });
  });

  it('maps Postgres unique violation (23505) to conflict', () => {
    const err = mapPgError({ code: '23505', message: 'duplicate key', detail: 'Key (...) exists' });
    expect(err.code).toBe('conflict');
  });

  it('maps Postgres foreign key violation (23503) to not_found', () => {
    const err = mapPgError({ code: '23503', message: 'fk violation', detail: 'Key not present' });
    expect(err.code).toBe('not_found');
  });

  it('maps unknown errors to internal', () => {
    const err = mapPgError({ code: '99999', message: 'who knows' });
    expect(err.code).toBe('internal');
  });
});
