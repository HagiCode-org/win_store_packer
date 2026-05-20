import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildPlan } from '../scripts/lib/build-plan.mjs';
import { readJson } from '../scripts/lib/fs-utils.mjs';
import { resolveDispatchBuildPlan } from '../scripts/resolve-dispatch-build-plan.mjs';

const DESKTOP_INDEX_URL = 'https://index.hagicode.com/desktop/index.json';
const SERVER_INDEX_URL = 'https://index.hagicode.com/server/index.json';
const DESKTOP_AZURE_SAS_URL = 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token';
const SERVER_AZURE_SAS_URL = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';
const DESKTOP_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/desktop/index.json?sp=racwl&sig=test-token';
const SERVER_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/server/index.json?sp=racwl&sig=test-token';

function createFetchStub({ requests = [] } = {}) {
  return async (url) => {
    requests.push(url);

    if (url === DESKTOP_INDEX_URL || url === DESKTOP_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: 'v0.2.0',
            assets: [
              'v0.2.0/hagicode.desktop.0.2.0-unpacked.zip'
            ]
          },
          {
            version: 'v0.3.0',
            assets: [
              'v0.3.0/hagicode.desktop.0.3.0-unpacked.zip'
            ]
          }
        ]
      });
    }

    if (url === SERVER_INDEX_URL || url === SERVER_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: '0.1.0-beta.33',
            assets: [
              '0.1.0-beta.33/hagicode-0.1.0-beta.33-win-x64-nort.zip'
            ]
          },
          {
            version: '0.1.0-beta.34',
            assets: [
              '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
            ]
          }
        ]
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

test('buildPlan resolves latest Desktop and Server versions and records the Desktop git tag', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      server: SERVER_AZURE_SAS_URL
    },
    findStoreRelease: async () => null,
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.deepEqual(plan.platforms, ['win-x64']);
  assert.equal(plan.upstream.desktop.version, 'v0.3.0');
  assert.equal(plan.upstream.desktop.tag, 'v0.3.0');
  assert.equal(plan.upstream.server.version, '0.1.0-beta.34');
  assert.equal(plan.release.tag, 'store-desktop-v0.3.0-server-v0.1.0-beta.34');
  assert.equal(plan.build.shouldBuild, true);
  assert.equal(plan.build.forceRebuild, false);
  assert.equal(plan.build.dryRun, false);
});

test('buildPlan defaults Desktop and Server discovery to direct Azure authority', async () => {
  const requests = [];
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      server: SERVER_AZURE_SAS_URL
    },
    findStoreRelease: async () => null,
    fetchImpl: createFetchStub({ requests }),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.deepEqual(requests, [DESKTOP_AZURE_MANIFEST_URL, SERVER_AZURE_MANIFEST_URL]);
  assert.equal(plan.upstream.desktop.manifestUrl, 'https://example.blob.core.windows.net/desktop/index.json?<sas-token-redacted>');
  assert.equal(plan.upstream.server.manifestUrl, 'https://example.blob.core.windows.net/server/index.json?<sas-token-redacted>');
});

test('buildPlan skips packaging when the Store release already exists and force_rebuild is disabled', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      server: SERVER_AZURE_SAS_URL
    },
    findStoreRelease: async () => ({
      tag_name: 'store-desktop-v0.3.0-server-v0.1.0-beta.34',
      html_url: 'https://github.com/HagiCode-org/win_store_packer/releases/tag/store-desktop-v0.3.0-server-v0.1.0-beta.34'
    }),
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.equal(plan.release.exists, true);
  assert.equal(plan.build.shouldBuild, false);
  assert.match(plan.build.skipReason, /already exists/i);
});

test('buildPlan respects manual selectors and force_rebuild', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: {
      inputs: {
        desktop_version: 'v0.2.0',
        server_version: '0.1.0-beta.33',
        force_rebuild: true,
        dry_run: true
      }
    },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      server: SERVER_AZURE_SAS_URL
    },
    findStoreRelease: async () => ({
      tag_name: 'store-desktop-v0.2.0-server-v0.1.0-beta.33',
      html_url: 'https://github.com/HagiCode-org/win_store_packer/releases/tag/store-desktop-v0.2.0-server-v0.1.0-beta.33'
    }),
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.equal(plan.upstream.desktop.version, 'v0.2.0');
  assert.equal(plan.upstream.server.version, '0.1.0-beta.33');
  assert.equal(plan.release.exists, true);
  assert.equal(plan.build.shouldBuild, true);
  assert.equal(plan.build.forceRebuild, true);
  assert.equal(plan.build.dryRun, true);
});

test('resolveDispatchBuildPlan writes the normalized plan artifact', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-build-plan-'));
  const outputPath = path.join(tempRoot, 'build-plan.json');

  const result = await resolveDispatchBuildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    outputPath,
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    desktopAzureSasUrl: DESKTOP_AZURE_SAS_URL,
    serverAzureSasUrl: SERVER_AZURE_SAS_URL,
    findStoreRelease: async () => null,
    fetchImpl: createFetchStub()
  });

  const writtenPlan = await readJson(outputPath);
  assert.equal(result.plan.release.tag, writtenPlan.release.tag);
  assert.equal(writtenPlan.upstream.desktop.tag, 'v0.3.0');
});
