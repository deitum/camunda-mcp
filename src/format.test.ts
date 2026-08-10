import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { type ActivityInstanceTree } from './camunda.types';
import {
  clampResults,
  flattenActivityTree,
  fromCamundaVariables,
  project,
  toCamundaVariables,
  truncate,
} from './format';

describe('clampResults', () => {
  test('falls back, clamps to the cap and refuses zero', () => {
    assert.equal(clampResults(undefined, 20), 20);
    assert.equal(clampResults(5, 20), 5);
    assert.equal(clampResults(5_000, 20), 100);
    assert.equal(clampResults(0, 20), 1);
  });
});

describe('truncate', () => {
  test('says how much it cut instead of trimming silently', () => {
    assert.equal(truncate('abc', 10), 'abc');
    assert.match(truncate('abcdef', 3), /^abc\n… truncated, 3 more characters$/);
  });
});

describe('project', () => {
  test('keeps the listed fields and drops empty ones', () => {
    const rows = [{ id: '1', key: 'scoring', tenantId: null, links: [], extra: 'noise' }];

    assert.deepEqual(project(rows, ['id', 'key', 'tenantId', 'missing']), [
      { id: '1', key: 'scoring' },
    ]);
  });
});

describe('toCamundaVariables', () => {
  test('infers the engine type from plain JSON', () => {
    assert.deepEqual(toCamundaVariables({ amount: 100, rate: 1.5, ok: true, name: 'x' }), {
      amount: { value: 100, type: 'Long' },
      rate: { value: 1.5, type: 'Double' },
      ok: { value: true, type: 'Boolean' },
      name: { value: 'x', type: 'String' },
    });
  });

  test('serialises objects and arrays as Json', () => {
    assert.deepEqual(toCamundaVariables({ payload: { a: 1 } }), {
      payload: { value: '{"a":1}', type: 'Json' },
    });
  });

  // The escape hatch for types we cannot infer (Date, Object with valueInfo).
  test('passes an explicit envelope through untouched', () => {
    assert.deepEqual(toCamundaVariables({ when: { value: '2026-08-01', type: 'Date' } }), {
      when: { value: '2026-08-01', type: 'Date' },
    });
  });

  test('returns undefined when there is nothing to send', () => {
    assert.equal(toCamundaVariables(undefined), undefined);
  });
});

describe('fromCamundaVariables', () => {
  test('unwraps the envelopes and caps a huge value', () => {
    const long = 'x'.repeat(3_000);

    assert.deepEqual(
      fromCamundaVariables({
        amount: { value: 100, type: 'Long' },
        blob: { value: long, type: 'String' },
      }),
      { amount: 100, blob: truncate(long, 2_000) },
    );
  });
});

describe('flattenActivityTree', () => {
  const tree: ActivityInstanceTree = {
    id: 'root:1',
    activityId: 'Process_1',
    childActivityInstances: [
      {
        id: 'sub:1',
        activityId: 'SubProcess_1',
        activityType: 'subProcess',
        childActivityInstances: [
          {
            id: 'task:1',
            activityId: 'UserTaskBankUnderwriterNew',
            activityType: 'userTask',
          },
        ],
      },
      {
        id: 'task:2',
        activityId: 'UserTaskInitiatorInputNew',
        activityType: 'userTask',
      },
    ],
  };

  test('returns the whole tree flattened', () => {
    assert.deepEqual(
      flattenActivityTree(tree).map((node) => node.id),
      ['root:1', 'sub:1', 'task:1', 'task:2'],
    );
  });

  // A modification cancels what the instance is actually waiting on, not the
  // scopes wrapping it.
  test('leavesOnly keeps the wait states and drops the scopes', () => {
    assert.deepEqual(
      flattenActivityTree(tree, true).map((node) => node.id),
      ['task:1', 'task:2'],
    );
  });

  test('handles a missing tree', () => {
    assert.deepEqual(flattenActivityTree(undefined), []);
  });
});
