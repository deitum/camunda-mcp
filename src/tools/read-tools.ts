import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DECISION_DEFINITION_FIELDS,
  DECISION_INSTANCE_FIELDS,
  DEPLOYMENT_FIELDS,
  HISTORY_ACTIVITY_FIELDS,
  HISTORY_PROCESS_INSTANCE_FIELDS,
  INCIDENT_FIELDS,
  MAX_XML_CHARS,
  PROCESS_DEFINITION_FIELDS,
  PROCESS_INSTANCE_FIELDS,
  TASK_FIELDS,
} from '../camunda.constants';
import {
  type ActivityInstanceTree,
  type CamundaConfig,
  type CamundaVariable,
} from '../camunda.types';
import { type CamundaClient } from '../client';
import {
  clampResults,
  flattenActivityTree,
  fromCamundaVariables,
  project,
  toCamundaVariables,
  truncate,
} from '../format';

import { definitionPath, maxResultsArg, run, variablesArg } from './tool-kit';

/** A history decision-instance input/output entry. */
interface DecisionClause {
  id: string;
  clauseId?: string;
  clauseName?: string;
  variableName?: string;
  value?: unknown;
}

interface DecisionInstance {
  inputs?: DecisionClause[];
  outputs?: DecisionClause[];
}

/** Collapses the engine's clause rows into `{ name: value }`. */
function clauses(rows: DecisionClause[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const row of rows ?? []) {
    result[row.variableName ?? row.clauseName ?? row.clauseId ?? row.id] = row.value ?? null;
  }
  return result;
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Tools that only look at the engine. They are always registered — the write
 * half is gated behind `CAMUNDA_ALLOW_WRITE`.
 *
 * `camunda_evaluate_decision` lives here on purpose: evaluating a DMN decision
 * changes no engine state (it only writes a history entry) and it is much of the
 * point of pointing this server at an engine's decision tables.
 */
export function registerReadTools(
  server: McpServer,
  client: CamundaClient,
  config: CamundaConfig,
): void {
  const limit = (value: number | undefined): number =>
    clampResults(value, config.defaultMaxResults);

  // ─── Decisions (DMN) ────────────────────────────────────────────────────────

  server.registerTool(
    'camunda_list_decision_definitions',
    {
      title: 'List DMN decisions',
      description:
        'Deployed DMN decision definitions (the Cockpit «Decisions» page). Filter by key or name; ' +
        'by default only the latest version of each decision is returned.',
      annotations: readOnly,
      inputSchema: {
        keyLike: z.string().optional().describe('Substring of the decision key.'),
        nameLike: z.string().optional().describe('Substring of the decision name.'),
        latestVersion: z
          .boolean()
          .optional()
          .describe('Only the newest version of each key (default true).'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('decision-definition', {
          query: {
            keyLike: args.keyLike,
            nameLike: args.nameLike,
            latestVersion: args.latestVersion ?? true,
            maxResults: limit(args.maxResults),
            sortBy: 'key',
            sortOrder: 'asc',
          },
        });
        return project(rows, DECISION_DEFINITION_FIELDS);
      }),
  );

  server.registerTool(
    'camunda_get_decision_dmn',
    {
      title: 'Get DMN XML',
      description:
        'The DMN 1.1 XML of a decision — the decision table itself: inputs, outputs, rules and hit policy.',
      annotations: readOnly,
      inputSchema: {
        key: z.string().optional().describe('Decision key; returns the latest deployed version.'),
        id: z.string().optional().describe('Decision definition id; returns that exact version.'),
      },
    },
    async (args) =>
      run(async () => {
        const path = definitionPath('decision-definition', args, 'xml');
        const xml = await client.get<{ id: string; dmnXml: string }>(path);
        return { id: xml.id, dmnXml: truncate(xml.dmnXml, MAX_XML_CHARS) };
      }),
  );

  server.registerTool(
    'camunda_evaluate_decision',
    {
      title: 'Evaluate a DMN decision',
      description:
        'Runs a decision against the given input variables and returns the matched output rows. ' +
        'Engine state is untouched (only a history entry is written), so this is the safe way to ' +
        'check what a decision table actually does for a given case.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        key: z.string().optional().describe('Decision key; evaluates the latest deployed version.'),
        id: z.string().optional().describe('Decision definition id; evaluates that exact version.'),
        variables: variablesArg.describe(
          'Decision inputs as plain JSON. Names must match the input variables of the DMN table.',
        ),
      },
    },
    async (args) =>
      run(async () => {
        const path = definitionPath('decision-definition', args, 'evaluate');
        const rows = await client.post<Record<string, CamundaVariable>[]>(path, {
          body: { variables: toCamundaVariables(args.variables) },
        });
        return (rows ?? []).map((row) => fromCamundaVariables(row));
      }),
  );

  server.registerTool(
    'camunda_list_decision_instances',
    {
      title: 'List DMN evaluations',
      description:
        'History of decision evaluations — when a decision ran, with which inputs and what it returned. ' +
        'This is how you find out why a process took a given branch.',
      annotations: readOnly,
      inputSchema: {
        decisionDefinitionKey: z.string().optional(),
        processInstanceId: z.string().optional(),
        includeInputs: z
          .boolean()
          .optional()
          .describe('Include the evaluated inputs (default true).'),
        includeOutputs: z
          .boolean()
          .optional()
          .describe('Include the produced outputs (default true).'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const includeInputs = args.includeInputs ?? true;
        const includeOutputs = args.includeOutputs ?? true;
        const rows = await client.get<(DecisionInstance & object)[]>('history/decision-instance', {
          query: {
            decisionDefinitionKey: args.decisionDefinitionKey,
            processInstanceId: args.processInstanceId,
            includeInputs,
            includeOutputs,
            maxResults: limit(args.maxResults),
            sortBy: 'evaluationTime',
            sortOrder: 'desc',
          },
        });
        return rows.map((row) => ({
          ...project([row], DECISION_INSTANCE_FIELDS)[0],
          ...(includeInputs ? { inputs: clauses(row.inputs) } : {}),
          ...(includeOutputs ? { outputs: clauses(row.outputs) } : {}),
        }));
      }),
  );

  // ─── Processes ──────────────────────────────────────────────────────────────

  server.registerTool(
    'camunda_list_process_definitions',
    {
      title: 'List process definitions',
      description: 'Deployed BPMN process definitions. Filter by key or name.',
      annotations: readOnly,
      inputSchema: {
        keyLike: z.string().optional().describe('Substring of the process key.'),
        nameLike: z.string().optional().describe('Substring of the process name.'),
        latestVersion: z
          .boolean()
          .optional()
          .describe('Only the newest version of each key (default true).'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('process-definition', {
          query: {
            keyLike: args.keyLike,
            nameLike: args.nameLike,
            latestVersion: args.latestVersion ?? true,
            maxResults: limit(args.maxResults),
            sortBy: 'key',
            sortOrder: 'asc',
          },
        });
        return project(rows, PROCESS_DEFINITION_FIELDS);
      }),
  );

  server.registerTool(
    'camunda_get_process_bpmn',
    {
      title: 'Get BPMN XML',
      description:
        'The BPMN 2.0 XML of a process definition — use it to look up activity ids before moving an instance.',
      annotations: readOnly,
      inputSchema: {
        key: z.string().optional().describe('Process key; returns the latest deployed version.'),
        id: z.string().optional().describe('Process definition id; returns that exact version.'),
      },
    },
    async (args) =>
      run(async () => {
        const path = definitionPath('process-definition', args, 'xml');
        const xml = await client.get<{ id: string; bpmn20Xml: string }>(path);
        return {
          id: xml.id,
          bpmn20Xml: truncate(xml.bpmn20Xml, MAX_XML_CHARS),
        };
      }),
  );

  server.registerTool(
    'camunda_list_process_instances',
    {
      title: 'List running instances',
      description:
        'Running process instances. `businessKey` is the domain identifier the instance was ' +
        'started with (an order number, an application id).',
      annotations: readOnly,
      inputSchema: {
        processDefinitionKey: z.string().optional(),
        businessKey: z.string().optional().describe('Exact business key of the instance.'),
        active: z.boolean().optional().describe('Only instances that are not suspended.'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('process-instance', {
          query: {
            processDefinitionKey: args.processDefinitionKey,
            businessKey: args.businessKey,
            active: args.active,
            maxResults: limit(args.maxResults),
          },
        });
        return project(rows, PROCESS_INSTANCE_FIELDS);
      }),
  );

  server.registerTool(
    'camunda_get_activity_instances',
    {
      title: 'Where an instance is now',
      description:
        'The activities a running instance is currently sitting on (the engine returns a tree; this ' +
        'flattens it). Returns `activityInstanceId`s, which is what a modification cancels.',
      annotations: readOnly,
      inputSchema: {
        processInstanceId: z.string(),
        leavesOnly: z
          .boolean()
          .optional()
          .describe('Drop the enclosing scopes and keep the actual wait states (default true).'),
      },
    },
    async (args) =>
      run(async () => {
        const tree = await client.get<ActivityInstanceTree>(
          `process-instance/${encodeURIComponent(args.processInstanceId)}/activity-instances`,
        );
        return flattenActivityTree(tree, args.leavesOnly ?? true);
      }),
  );

  server.registerTool(
    'camunda_list_variables',
    {
      title: 'Instance variables',
      description: 'Variables of a running process instance, unwrapped to plain JSON.',
      annotations: readOnly,
      inputSchema: { processInstanceId: z.string() },
    },
    async (args) =>
      run(async () => {
        const variables = await client.get<Record<string, CamundaVariable>>(
          `process-instance/${encodeURIComponent(args.processInstanceId)}/variables`,
          { query: { deserializeValues: false } },
        );
        return fromCamundaVariables(variables);
      }),
  );

  server.registerTool(
    'camunda_list_tasks',
    {
      title: 'List user tasks',
      description:
        'Open user tasks. Filtering by `processInstanceBusinessKey` is the usual way to find the ' +
        'tasks of one application.',
      annotations: readOnly,
      inputSchema: {
        processInstanceBusinessKey: z.string().optional(),
        processInstanceId: z.string().optional(),
        taskDefinitionKey: z.string().optional(),
        assignee: z.string().optional(),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('task', {
          query: {
            processInstanceBusinessKey: args.processInstanceBusinessKey,
            processInstanceId: args.processInstanceId,
            taskDefinitionKey: args.taskDefinitionKey,
            assignee: args.assignee,
            maxResults: limit(args.maxResults),
          },
        });
        return project(rows, TASK_FIELDS);
      }),
  );

  // ─── Failures ───────────────────────────────────────────────────────────────

  server.registerTool(
    'camunda_list_incidents',
    {
      title: 'List incidents',
      description:
        'Open incidents (failed jobs, failed external tasks). For a `failedJob` incident the ' +
        '`configuration` field is the job id — pass it to camunda_get_job_stacktrace for the exception.',
      annotations: readOnly,
      inputSchema: {
        processInstanceId: z.string().optional(),
        processDefinitionId: z.string().optional(),
        incidentType: z.string().optional().describe('e.g. failedJob, failedExternalTask.'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('incident', {
          query: {
            processInstanceId: args.processInstanceId,
            processDefinitionId: args.processDefinitionId,
            incidentType: args.incidentType,
            maxResults: limit(args.maxResults),
          },
        });
        return project(rows, INCIDENT_FIELDS);
      }),
  );

  server.registerTool(
    'camunda_get_job_stacktrace',
    {
      title: 'Job stacktrace',
      description:
        'The exception stacktrace of a failed job — the actual cause behind an incident.',
      annotations: readOnly,
      inputSchema: {
        jobId: z.string().describe('Job id, i.e. the `configuration` of a failedJob incident.'),
      },
    },
    async (args) =>
      run(async () => {
        const trace = await client.get<string>(`job/${encodeURIComponent(args.jobId)}/stacktrace`, {
          raw: true,
        });
        return truncate(trace, MAX_XML_CHARS);
      }),
  );

  // ─── History ────────────────────────────────────────────────────────────────

  server.registerTool(
    'camunda_list_history_process_instances',
    {
      title: 'History: instances',
      description:
        'Finished and running instances from the history tables — the only way to see an instance ' +
        'that has already ended.',
      annotations: readOnly,
      inputSchema: {
        processDefinitionKey: z.string().optional(),
        processInstanceBusinessKey: z.string().optional(),
        finished: z.boolean().optional(),
        unfinished: z.boolean().optional(),
        withIncidents: z.boolean().optional(),
        startedAfter: z
          .string()
          .optional()
          .describe('ISO-8601, e.g. 2026-08-01T00:00:00.000+0300.'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('history/process-instance', {
          query: {
            processDefinitionKey: args.processDefinitionKey,
            processInstanceBusinessKey: args.processInstanceBusinessKey,
            finished: args.finished,
            unfinished: args.unfinished,
            withIncidents: args.withIncidents,
            startedAfter: args.startedAfter,
            maxResults: limit(args.maxResults),
            sortBy: 'startTime',
            sortOrder: 'desc',
          },
        });
        return project(rows, HISTORY_PROCESS_INSTANCE_FIELDS);
      }),
  );

  server.registerTool(
    'camunda_list_history_activities',
    {
      title: 'History: activities',
      description:
        'The activities one instance went through, in order — the audit trail of a single application.',
      annotations: readOnly,
      inputSchema: {
        processInstanceId: z.string(),
        activityType: z.string().optional().describe('e.g. userTask, serviceTask, callActivity.'),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('history/activity-instance', {
          query: {
            processInstanceId: args.processInstanceId,
            activityType: args.activityType,
            maxResults: limit(args.maxResults),
            sortBy: 'startTime',
            sortOrder: 'asc',
          },
        });
        return project(rows, HISTORY_ACTIVITY_FIELDS);
      }),
  );

  // ─── Deployments + escape hatch ─────────────────────────────────────────────

  server.registerTool(
    'camunda_list_deployments',
    {
      title: 'List deployments',
      description: 'Deployments, newest first — what was deployed to the engine and when.',
      annotations: readOnly,
      inputSchema: {
        nameLike: z.string().optional(),
        maxResults: maxResultsArg,
      },
    },
    async (args) =>
      run(async () => {
        const rows = await client.get<object[]>('deployment', {
          query: {
            nameLike: args.nameLike,
            maxResults: limit(args.maxResults),
            sortBy: 'deploymentTime',
            sortOrder: 'desc',
          },
        });
        return project(rows, DEPLOYMENT_FIELDS);
      }),
  );

  server.registerTool(
    'camunda_get_deployment_resource',
    {
      title: 'Deployment resources',
      description:
        'Without `resourceId`: the files of a deployment. With it: the file itself (BPMN/DMN source).',
      annotations: readOnly,
      inputSchema: {
        deploymentId: z.string(),
        resourceId: z.string().optional(),
      },
    },
    async (args) =>
      run(async () => {
        const base = `deployment/${encodeURIComponent(args.deploymentId)}/resources`;
        if (!args.resourceId) {
          return client.get<object[]>(base);
        }
        const data = await client.get<string>(
          `${base}/${encodeURIComponent(args.resourceId)}/data`,
          { raw: true },
        );
        return truncate(data, MAX_XML_CHARS);
      }),
  );

  server.registerTool(
    'camunda_get',
    {
      title: 'Raw engine GET',
      description:
        'Escape hatch: any GET of the Camunda 7 REST API by path, for endpoints the other tools do ' +
        'not cover (e.g. "external-task", "job-definition", "history/variable-instance"). Read-only.',
      annotations: readOnly,
      inputSchema: {
        path: z.string().describe('Path relative to the engine root, without a leading slash.'),
        query: z.record(z.string(), z.string()).optional().describe('Query parameters.'),
      },
    },
    async (args) => run(async () => client.get<unknown>(args.path, { query: args.query })),
  );
}
