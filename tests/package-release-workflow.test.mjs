import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/package-release.yml', import.meta.url));
const previewPath = fileURLToPath(new URL('../.github/workflows/release-plan-preview.yml', import.meta.url));

test('package release workflow produces only unsigned packages without Azure signing', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /variant:\n\s+- unsigned/);
  assert.doesNotMatch(workflow, /-\s+signed/);
  assert.doesNotMatch(workflow, /azure\/login|azure\/artifact-signing-action|AZURE_CODESIGN|AZURE_CLIENT_/);
  assert.doesNotMatch(workflow, /id-token:\s+write/);
  assert.doesNotMatch(workflow, /finalize-msix-signing/);
});

test('preview runs on schedule and dispatch, validates before unpublished writeback', async () => {
  const workflow = await readFile(previewPath, 'utf8');
  assert.match(workflow, /schedule:\n\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release-drafter\/release-drafter@v7/);
  assert.match(workflow, /dry-run: true/);
  assert.match(workflow, /resolve-dispatch-build-plan\.mjs[\s\S]*resolve-release-plan\.mjs/);
  assert.match(workflow, /needs: preview[\s\S]*--status unpublished/);
  assert.doesNotMatch(workflow, /publish-release\.mjs|build-msix\.mjs/);
});

test('only successful real publication writes the validated release-time artifact', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const preview = await readFile(previewPath, 'utf8');
  const job = workflow.split('\n  write_history:')[1].split('\n  draft_release:')[0];
  assert.match(job, /needs\.publish\.result == 'success'/);
  assert.match(job, /publication_mode == 'github-release'/);
  assert.match(job, /dry_run == 'false'/);
  assert.match(job, /inputs\.build_mode == 'published-release'/);
  assert.match(job, /name: \$\{\{ env\.RESOLVED_BUILD_PLAN_ARTIFACT_NAME \}\}/);
  assert.match(job, /--status published/);
  assert.doesNotMatch(job, /resolve-dispatch-build-plan\.mjs/);
  assert.match(job, /git push origin "HEAD:/);
  assert.match(job, /group: release-plan-history-\$\{\{ github\.repository \}\}/);
  assert.match(preview, /group: release-plan-history-\$\{\{ github\.repository \}\}/);
});
