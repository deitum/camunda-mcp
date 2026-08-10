import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { type ActivityInstanceTree, type ModificationInstruction } from '../camunda.types';
import { type CamundaClient } from '../client';
import { flattenActivityTree, toCamundaVariables } from '../format';

import { run, variablesArg } from './tool-kit';

const mutating = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

/**
 * Tools that change the engine. Registered only when `CAMUNDA_ALLOW_WRITE=true`,
 * so a connection meant for looking around cannot start or cancel anything even
 * if the model decides to try: the tools are simply not in its list.
 */
export function registerWriteTools(server: McpServer, client: CamundaClient): void {
  server.registerTool(
    'camunda_start_process_instance',
    {
      title: 'Start a process instance',
      description: 'Starts a new instance of a process definition by key.',
      annotations: { ...mutating, destructiveHint: false },
      inputSchema: {
        key: z.string().describe('Process definition key.'),
        businessKey: z.string().optional().describe('Business key of the new instance.'),
        variables: variablesArg,
      },
    },
    async (args) =>
      run(async () =>
        client.post<unknown>(`process-definition/key/${encodeURIComponent(args.key)}/start`, {
          body: {
            ...(args.businessKey ? { businessKey: args.businessKey } : {}),
            variables: toCamundaVariables(args.variables) ?? {},
          },
        }),
      ),
  );

  server.registerTool(
    'camunda_complete_task',
    {
      title: 'Complete a user task',
      description: 'Completes a user task, optionally setting the variables its form expects.',
      annotations: mutating,
      inputSchema: { taskId: z.string(), variables: variablesArg },
    },
    async (args) =>
      run(async () =>
        client.post<unknown>(`task/${encodeURIComponent(args.taskId)}/complete`, {
          body: { variables: toCamundaVariables(args.variables) ?? {} },
        }),
      ),
  );

  server.registerTool(
    'camunda_modify_process_instance',
    {
      title: 'Move an instance to an activity',
      description:
        'Moves a running instance to another activity — the same trick the autotests use to skip ' +
        'ahead in a long process. Starts the target activity first and then cancels the ones the ' +
        'instance was sitting on (that order matters: cancelling everything first would end the ' +
        'instance). Without `cancelActivityInstanceIds` the current wait states are looked up and ' +
        'cancelled; pass an empty array to keep them running in parallel.',
      annotations: mutating,
      inputSchema: {
        processInstanceId: z.string(),
        startBeforeActivityId: z.string().describe('Activity id to move the instance to.'),
        cancelActivityInstanceIds: z
          .array(z.string())
          .optional()
          .describe('Activity *instance* ids to cancel (from camunda_get_activity_instances).'),
        variables: variablesArg,
        skipCustomListeners: z.boolean().optional().describe('Default true.'),
        skipIoMappings: z.boolean().optional().describe('Default true.'),
      },
    },
    async (args) =>
      run(async () => {
        const cancelIds =
          args.cancelActivityInstanceIds ??
          (await currentActivityInstanceIds(client, args.processInstanceId));

        const instructions: ModificationInstruction[] = [
          {
            type: 'startBeforeActivity',
            activityId: args.startBeforeActivityId,
            ...(args.variables ? { variables: toCamundaVariables(args.variables) } : {}),
          },
          ...cancelIds.map<ModificationInstruction>((activityInstanceId) => ({
            type: 'cancel',
            activityInstanceId,
          })),
        ];

        await client.post<unknown>(
          `process-instance/${encodeURIComponent(args.processInstanceId)}/modification`,
          {
            body: {
              instructions,
              skipCustomListeners: args.skipCustomListeners ?? true,
              skipIoMappings: args.skipIoMappings ?? true,
            },
          },
        );
        return {
          movedTo: args.startBeforeActivityId,
          cancelledActivityInstanceIds: cancelIds,
          note: 'The engine answers before the new task exists — poll camunda_list_tasks.',
        };
      }),
  );

  server.registerTool(
    'camunda_set_variables',
    {
      title: 'Set instance variables',
      description: 'Creates or updates variables on a running process instance.',
      annotations: mutating,
      inputSchema: {
        processInstanceId: z.string(),
        variables: variablesArg.describe('Variables to set, as plain JSON.'),
      },
    },
    async (args) =>
      run(async () =>
        client.post<unknown>(
          `process-instance/${encodeURIComponent(args.processInstanceId)}/variables`,
          { body: { modifications: toCamundaVariables(args.variables) ?? {} } },
        ),
      ),
  );

  server.registerTool(
    'camunda_send_message',
    {
      title: 'Correlate a message',
      description:
        'Delivers a BPMN message to a waiting instance (message start/intermediate events). ' +
        'Address it with `businessKey` or `processInstanceId`.',
      annotations: mutating,
      inputSchema: {
        messageName: z.string(),
        businessKey: z.string().optional(),
        processInstanceId: z.string().optional(),
        correlationKeys: variablesArg.describe('Variables the waiting instance is matched by.'),
        processVariables: variablesArg.describe('Variables set on correlation.'),
        all: z
          .boolean()
          .optional()
          .describe('Correlate to every matching instance (default false).'),
      },
    },
    async (args) =>
      run(async () =>
        client.post<unknown>('message', {
          body: {
            messageName: args.messageName,
            ...(args.businessKey ? { businessKey: args.businessKey } : {}),
            ...(args.processInstanceId ? { processInstanceId: args.processInstanceId } : {}),
            ...(args.correlationKeys
              ? { correlationKeys: toCamundaVariables(args.correlationKeys) }
              : {}),
            ...(args.processVariables
              ? { processVariables: toCamundaVariables(args.processVariables) }
              : {}),
            all: args.all ?? false,
            resultEnabled: true,
          },
        }),
      ),
  );

  server.registerTool(
    'camunda_set_job_retries',
    {
      title: 'Retry a failed job',
      description:
        'Sets the retry count of a job — the usual way to re-run the failed job behind an incident ' +
        "(the job id is the incident's `configuration`).",
      annotations: { ...mutating, idempotentHint: true },
      inputSchema: {
        jobId: z.string(),
        retries: z.number().int().min(0).describe('Usually 1, to run the job once more.'),
      },
    },
    async (args) =>
      run(async () =>
        client.put<unknown>(`job/${encodeURIComponent(args.jobId)}/retries`, {
          body: { retries: args.retries },
        }),
      ),
  );

  server.registerTool(
    'camunda_resolve_incident',
    {
      title: 'Resolve an incident',
      description:
        'Marks an incident as resolved without touching its cause. For a failed job prefer ' +
        'camunda_set_job_retries — that actually retries the work.',
      annotations: mutating,
      inputSchema: { incidentId: z.string() },
    },
    async (args) =>
      run(async () => client.delete<unknown>(`incident/${encodeURIComponent(args.incidentId)}`)),
  );

  server.registerTool(
    'camunda_delete_process_instance',
    {
      title: 'Delete an instance',
      description: 'Cancels and deletes a running process instance. This cannot be undone.',
      annotations: mutating,
      inputSchema: {
        processInstanceId: z.string(),
        skipCustomListeners: z.boolean().optional().describe('Default true.'),
        skipIoMappings: z.boolean().optional().describe('Default true.'),
      },
    },
    async (args) =>
      run(async () =>
        client.delete<unknown>(`process-instance/${encodeURIComponent(args.processInstanceId)}`, {
          query: {
            skipCustomListeners: args.skipCustomListeners ?? true,
            skipIoMappings: args.skipIoMappings ?? true,
          },
        }),
      ),
  );
}

/** The activity-instance ids a running instance is currently waiting on. */
async function currentActivityInstanceIds(
  client: CamundaClient,
  processInstanceId: string,
): Promise<string[]> {
  const tree = await client.get<ActivityInstanceTree>(
    `process-instance/${encodeURIComponent(processInstanceId)}/activity-instances`,
  );
  return flattenActivityTree(tree, true).map((node) => node.id);
}
