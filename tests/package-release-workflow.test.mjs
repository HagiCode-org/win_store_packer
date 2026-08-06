import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/package-release.yml', import.meta.url));

test('package release workflow produces only unsigned packages without Azure signing', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /variant:\n\s+- unsigned/);
  assert.doesNotMatch(workflow, /-\s+signed/);
  assert.doesNotMatch(workflow, /azure\/login|azure\/artifact-signing-action|AZURE_CODESIGN|AZURE_CLIENT_/);
  assert.doesNotMatch(workflow, /id-token:\s+write/);
  assert.doesNotMatch(workflow, /finalize-msix-signing/);
});
