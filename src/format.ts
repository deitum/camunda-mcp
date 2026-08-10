import { MAX_RESULTS_CAP, MAX_VARIABLE_CHARS } from './camunda.constants';
import { type ActivityInstanceTree, type CamundaVariable } from './camunda.types';

/** Keeps `maxResults` inside `[1, MAX_RESULTS_CAP]`, falling back to the configured default. */
export function clampResults(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS_CAP);
}

/** Cuts `text` down to `max` characters, saying so rather than truncating silently. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… truncated, ${text.length - max} more characters`;
}

/**
 * Narrows engine rows to the fields worth showing. The engine returns a couple
 * of dozen keys per row (`tenantId`, `caseInstanceId`, link objects…) and a page
 * of them buries the answer the model is looking for.
 */
export function project<T extends object>(
  rows: T[],
  fields: readonly string[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const field of fields) {
      if (record[field] !== undefined && record[field] !== null) {
        picked[field] = record[field];
      }
    }
    return picked;
  });
}

/**
 * Turns plain JSON into the engine's `{ value, type }` envelopes.
 *
 * A value that already looks like an envelope is passed through untouched, which
 * is the escape hatch for the types we cannot infer (`Json`, `Date`, `Object`
 * with a `valueInfo`).
 */
export function toCamundaVariables(
  variables: Record<string, unknown> | undefined,
): Record<string, CamundaVariable> | undefined {
  if (!variables) {
    return undefined;
  }
  const result: Record<string, CamundaVariable> = {};
  for (const [name, raw] of Object.entries(variables)) {
    result[name] = isEnvelope(raw) ? raw : toVariable(raw);
  }
  return result;
}

/** Unwraps `{ value, type }` envelopes back into plain JSON for the model. */
export function fromCamundaVariables(
  variables: Record<string, CamundaVariable> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, variable] of Object.entries(variables ?? {})) {
    const value = variable?.value;
    result[name] =
      typeof value === 'string' ? truncate(value, MAX_VARIABLE_CHARS) : (value ?? null);
  }
  return result;
}

/**
 * Flattens the activity-instance tree into the rows a person reads in Cockpit:
 * which activities the instance is sitting on right now. `leavesOnly` keeps the
 * actual wait states and drops the enclosing scopes (the process itself,
 * subprocesses), which is what a modification wants to cancel.
 */
export function flattenActivityTree(
  node: ActivityInstanceTree | undefined,
  leavesOnly = false,
): {
  id: string;
  activityId: string;
  activityName?: string;
  activityType?: string;
}[] {
  if (!node) {
    return [];
  }
  const children = [
    ...(node.childActivityInstances ?? []),
    ...(node.childTransitionInstances ?? []),
  ];
  const nested = children.flatMap((child) => flattenActivityTree(child, leavesOnly));

  if (leavesOnly && children.length > 0) {
    return nested;
  }
  return [
    {
      id: node.id,
      activityId: node.activityId,
      ...(node.activityName !== undefined ? { activityName: node.activityName } : {}),
      ...(node.activityType !== undefined ? { activityType: node.activityType } : {}),
    },
    ...nested,
  ];
}

function isEnvelope(value: unknown): value is CamundaVariable {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'value' in value;
}

/**
 * Wraps a plain JSON value in the engine's envelope, inferring the type.
 *
 * Objects and arrays are sent as `Json`, which needs camunda-spin on the engine;
 * an engine without it answers with a clear "unsupported value type", and the
 * caller can then pass the envelope by hand.
 */
function toVariable(value: unknown): CamundaVariable {
  if (typeof value === 'boolean') {
    return { value, type: 'Boolean' };
  }
  if (typeof value === 'number') {
    return { value, type: Number.isInteger(value) ? 'Long' : 'Double' };
  }
  if (typeof value === 'string') {
    return { value, type: 'String' };
  }
  if (value === null || value === undefined) {
    return { value: null };
  }
  return { value: JSON.stringify(value), type: 'Json' };
}
