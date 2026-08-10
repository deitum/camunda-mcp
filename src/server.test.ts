import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, test } from 'vitest';

import { type CamundaConfig, type FetchLike } from './camunda.types';
import { createCamundaServer } from './server';

const CONFIG: CamundaConfig = {
  baseUrl: 'https://camunda.example/engine-rest',
  allowWrite: false,
  defaultMaxResults: 20,
  timeoutMs: 1_000,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Connects an in-memory MCP client to a server built over the given engine stub. */
async function connect(
  config: Partial<CamundaConfig>,
  fetch: FetchLike = () => Promise.resolve(json([])),
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createCamundaServer({ ...CONFIG, ...config }, { fetch });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function toolNames(config: Partial<CamundaConfig>): Promise<string[]> {
  const { client, close } = await connect(config);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await close();
  }
}

/** The text of a tool result, which is where every tool puts its payload. */
function text(result: unknown): string {
  const blocks = (result as { content?: { text?: string }[] }).content ?? [];
  return blocks.map((block) => block.text ?? '').join('\n');
}

describe('createCamundaServer', () => {
  test('offers the read tools and hides the write ones by default', async () => {
    const names = await toolNames({ allowWrite: false });

    assert.ok(names.includes('camunda_list_decision_definitions'));
    assert.ok(names.includes('camunda_get_decision_dmn'));
    assert.ok(names.includes('camunda_evaluate_decision'));
    assert.ok(names.includes('camunda_list_incidents'));
    assert.equal(
      names.some((name) => name.startsWith('camunda_start') || name.startsWith('camunda_delete')),
      false,
      'write tools must not be registered without CAMUNDA_ALLOW_WRITE',
    );
  });

  // Refusing in a description is not a control; not registering the tool is.
  test('adds the write tools when CAMUNDA_ALLOW_WRITE is on', async () => {
    const names = await toolNames({ allowWrite: true });

    for (const name of [
      'camunda_start_process_instance',
      'camunda_complete_task',
      'camunda_modify_process_instance',
      'camunda_delete_process_instance',
    ]) {
      assert.ok(names.includes(name), `${name} is missing`);
    }
  });

  test('a list tool narrows the engine rows and applies the page size', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = (url) => {
      urls.push(url);
      return Promise.resolve(
        json([
          {
            id: 'scoring:1:abc',
            key: 'scoring',
            name: 'Scoring',
            version: 1,
            tenantId: null,
            historyTimeToLive: null,
          },
        ]),
      );
    };

    const { client, close } = await connect({}, fetch);
    try {
      const result = await client.callTool({
        name: 'camunda_list_decision_definitions',
        arguments: { keyLike: 'scor' },
      });

      assert.deepEqual(JSON.parse(text(result)), [
        { id: 'scoring:1:abc', key: 'scoring', name: 'Scoring', version: 1 },
      ]);
      assert.match(urls[0], /decision-definition\?keyLike=scor&latestVersion=true&maxResults=20/);
    } finally {
      await close();
    }
  });

  test('evaluating a decision sends typed variables and unwraps the result', async () => {
    let body: unknown;
    const fetch: FetchLike = (_url, init) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return Promise.resolve(json([{ decision: { value: 'APPROVE', type: 'String' } }]));
    };

    const { client, close } = await connect({}, fetch);
    try {
      const result = await client.callTool({
        name: 'camunda_evaluate_decision',
        arguments: { key: 'scoring', variables: { amount: 100, vip: true } },
      });

      assert.deepEqual(body, {
        variables: {
          amount: { value: 100, type: 'Long' },
          vip: { value: true, type: 'Boolean' },
        },
      });
      assert.deepEqual(JSON.parse(text(result)), [{ decision: 'APPROVE' }]);
    } finally {
      await close();
    }
  });

  // A failed call must leave the model free to try another filter rather than
  // blow up the turn.
  test('an engine error comes back as an isError result, not a thrown request', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(json({ type: 'RestException', message: 'No matching decision' }, 404));

    const { client, close } = await connect({}, fetch);
    try {
      const result = await client.callTool({
        name: 'camunda_get_decision_dmn',
        arguments: { key: 'nope' },
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /RestException: No matching decision/);
    } finally {
      await close();
    }
  });

  test('asks for a key or an id rather than guessing', async () => {
    const { client, close } = await connect({});
    try {
      const result = await client.callTool({
        name: 'camunda_get_decision_dmn',
        arguments: {},
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /Pass either `key`.*or `id`/);
    } finally {
      await close();
    }
  });

  test('a modification starts the target activity before cancelling the current ones', async () => {
    const bodies: unknown[] = [];
    const fetch: FetchLike = (url, init) => {
      if (url.endsWith('/activity-instances')) {
        return Promise.resolve(
          json({
            id: 'root:1',
            activityId: 'Process_1',
            childActivityInstances: [
              {
                id: 'task:1',
                activityId: 'UserTaskInitiatorInputNew',
                activityType: 'userTask',
              },
            ],
          }),
        );
      }
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const { client, close } = await connect({ allowWrite: true }, fetch);
    try {
      await client.callTool({
        name: 'camunda_modify_process_instance',
        arguments: {
          processInstanceId: 'pi-1',
          startBeforeActivityId: 'UserTaskBankULApproveNew',
        },
      });

      assert.deepEqual(bodies[0], {
        instructions: [
          {
            type: 'startBeforeActivity',
            activityId: 'UserTaskBankULApproveNew',
          },
          { type: 'cancel', activityInstanceId: 'task:1' },
        ],
        skipCustomListeners: true,
        skipIoMappings: true,
      });
    } finally {
      await close();
    }
  });
});
