import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ErrorCode = 'invalid_input' | 'not_found' | 'conflict' | 'claim_race' | 'internal';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
}

export function mapPgError(err: PgErrorLike): AppError {
  switch (err.code) {
    case '23505': // unique_violation
      return new AppError('conflict', err.message ?? 'unique constraint violated');
    case '23503': // foreign_key_violation
      return new AppError('not_found', err.message ?? 'referenced row not found');
    default:
      return new AppError('internal', err.message ?? 'internal error');
  }
}

export function errorToToolResult(err: AppError): CallToolResult {
  const payload = { error: { code: err.code, message: err.message, issues: err.issues } };
  // Strip undefined for clean output
  if (payload.error.issues === undefined) delete (payload.error as Record<string, unknown>).issues;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}
