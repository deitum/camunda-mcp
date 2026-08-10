import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MAX_RESULT_CHARS, MAX_RESULTS_CAP } from '../camunda.constants';
import { truncate } from '../format';

/**
 * Runs a tool body and shapes whatever comes back into an MCP result.
 *
 * Errors are returned as `isError` results rather than thrown: a failing tool
 * call should leave the model free to try something else (a different filter, a
 * different endpoint) instead of killing the whole turn.
 */
export async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await body();
    return {
      content: [{ type: 'text', text: truncate(stringify(value), MAX_RESULT_CHARS) }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function stringify(value: unknown): string {
  if (value === undefined) {
    return 'OK';
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Shared argument fragments so every list tool describes paging the same way. */
export const maxResultsArg = z
  .number()
  .int()
  .positive()
  .max(MAX_RESULTS_CAP)
  .optional()
  .describe(`Rows to return (max ${MAX_RESULTS_CAP}).`);

export const variablesArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Process variables as plain JSON ({"amount": 100}); types are inferred. Pass the engine ' +
      'envelope ({"amount": {"value": "100", "type": "String"}}) when you need an exact type.',
  );

/** Requires exactly one of the two identifiers a definition can be addressed by. */
export function definitionPath(
  resource: 'process-definition' | 'decision-definition',
  args: { id?: string; key?: string },
  suffix: string,
): string {
  if (args.id) {
    return `${resource}/${encodeURIComponent(args.id)}/${suffix}`;
  }
  if (args.key) {
    return `${resource}/key/${encodeURIComponent(args.key)}/${suffix}`;
  }
  throw new Error('Pass either `key` (latest version) or `id` (one exact version).');
}
