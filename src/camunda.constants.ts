/**
 * Kept in step with `package.json` by `scripts/sync-version.mjs`, which
 * `npm run changeset:version` runs after the release bump.
 */
export const SERVER_VERSION = '0.3.0';

/** Identity reported to the MCP client during initialisation. */
export const SERVER_INFO = {
  name: 'camunda-mcp',
  version: SERVER_VERSION,
} as const;

/** How many rows a list tool returns when the model does not say. */
export const DEFAULT_MAX_RESULTS = 20;

/**
 * Ceiling on `maxResults`. The engine happily returns thousands of rows and the
 * whole page ends up in the model's context, so the cap is enforced here rather
 * than trusted to the caller.
 */
export const MAX_RESULTS_CAP = 100;

/** Budget for a single engine request — an engine that hangs must fail one tool call. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Budget for a token request; the identity provider is a separate host. */
export const TOKEN_TIMEOUT_MS = 15_000;

/**
 * Renew the access token this long before it actually expires, so a token that
 * is valid when we check is still valid when the engine sees it.
 */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/** Cookie the token is sent in when the transport is `cookie` rather than a header. */
export const DEFAULT_AUTH_COOKIE_NAME = 'JWT';

/**
 * The cookie-name charset of RFC 6265. Checked because a name carrying `;` or
 * `=` would let a config value append a header of its own to every request.
 */
export const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Cap on a BPMN/DMN XML payload handed to the model. */
export const MAX_XML_CHARS = 40_000;

/** Cap on any single tool result; the last resort against a huge engine page. */
export const MAX_RESULT_CHARS = 60_000;

/** Cap on one variable's stringified value inside a variables listing. */
export const MAX_VARIABLE_CHARS = 2_000;

/** Fields kept from a process/decision definition row. */
export const PROCESS_DEFINITION_FIELDS = [
  'id',
  'key',
  'name',
  'version',
  'versionTag',
  'resource',
  'deploymentId',
  'suspended',
] as const;

export const DECISION_DEFINITION_FIELDS = [
  'id',
  'key',
  'name',
  'version',
  'versionTag',
  'decisionRequirementsDefinitionKey',
  'resource',
  'deploymentId',
] as const;

export const PROCESS_INSTANCE_FIELDS = [
  'id',
  'definitionId',
  'businessKey',
  'caseInstanceId',
  'suspended',
  'tenantId',
] as const;

export const HISTORY_PROCESS_INSTANCE_FIELDS = [
  'id',
  'processDefinitionKey',
  'processDefinitionVersion',
  'businessKey',
  'startTime',
  'endTime',
  'durationInMillis',
  'state',
  'startActivityId',
  'deleteReason',
] as const;

export const HISTORY_ACTIVITY_FIELDS = [
  'id',
  'activityId',
  'activityName',
  'activityType',
  'assignee',
  'startTime',
  'endTime',
  'durationInMillis',
  'canceled',
  'completeScope',
] as const;

export const TASK_FIELDS = [
  'id',
  'name',
  'taskDefinitionKey',
  'assignee',
  'created',
  'due',
  'priority',
  'processInstanceId',
  'processDefinitionId',
] as const;

export const INCIDENT_FIELDS = [
  'id',
  'incidentType',
  'incidentMessage',
  'incidentTimestamp',
  'activityId',
  'causeIncidentId',
  'rootCauseIncidentId',
  'configuration',
  'processInstanceId',
  'processDefinitionId',
] as const;

export const DEPLOYMENT_FIELDS = ['id', 'name', 'source', 'deploymentTime', 'tenantId'] as const;

export const DECISION_INSTANCE_FIELDS = [
  'id',
  'decisionDefinitionKey',
  'decisionDefinitionName',
  'evaluationTime',
  'processDefinitionKey',
  'processInstanceId',
  'activityId',
  'rootDecisionInstanceId',
  'collectResultValue',
] as const;
