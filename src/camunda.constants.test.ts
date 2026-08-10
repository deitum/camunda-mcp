import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, test } from 'vitest';

import { SERVER_INFO, SERVER_VERSION } from './camunda.constants';

describe('SERVER_INFO', () => {
  // `scripts/sync-version.mjs`, which `npm run changeset:version` runs, keeps
  // these in step; this is what notices when a version was bumped by hand.
  test('reports the published version', () => {
    // Vitest runs from the project root, where `vitest.config.mts` lives.
    const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };

    assert.equal(SERVER_VERSION, version);
    assert.equal(SERVER_INFO.version, version);
  });

  test('is named after the package, not the repository it grew up in', () => {
    assert.equal(SERVER_INFO.name, 'camunda-mcp');
  });
});
