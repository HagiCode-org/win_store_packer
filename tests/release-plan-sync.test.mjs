import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { downloadReleasePlan } from '../scripts/download-release-plan.mjs';
import { syncReleasePlan } from '../scripts/sync-release-plan.mjs';

const DESKTOP_AZURE_SAS_URL = 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token';
const SERVER_AZURE_SAS_URL = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';
const DLC_AZURE_SAS_URL = 'https://example.blob.core.windows.net/dlc?sp=racwl&sig=test-token';
const DESKTOP_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/desktop/index.json?sp=racwl&sig=test-token';
const SERVER_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/server/index.json?sp=racwl&sig=test-token';
const DLC_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/dlc/index.json?sp=racwl&sig=test-token';
const PACKER_RELEASE_TAG = 'v1.4.0';

function createSyncFetchStub({ requests = [], includeDraft = true, includeExistingPlanAsset = true } = {}) {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ url: String(url), method });

    if (String(url) === 'https://api.github.com/repos/HagiCode-org/win_store_packer/releases?per_page=100') {
      return Response.json(includeDraft ? [
        {
          id: 42,
          tag_name: PACKER_RELEASE_TAG,
          draft: true,
          html_url: `https://github.com/HagiCode-org/win_store_packer/releases/tag/${PACKER_RELEASE_TAG}`,
          created_at: '2026-04-21T00:00:00.000Z',
          upload_url: 'https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets{?name,label}',
          assets: includeExistingPlanAsset
            ? [{ id: 99, name: 'release-plan.json', browser_download_url: 'https://example.test/release-plan.json' }]
            : []
        }
      ] : []);
    }

    if (String(url) === `https://api.github.com/repos/HagiCode-org/win_store_packer/releases/tags/${encodeURIComponent(PACKER_RELEASE_TAG)}`) {
      return Response.json({
        id: 42,
        tag_name: PACKER_RELEASE_TAG,
        draft: false,
        html_url: `https://github.com/HagiCode-org/win_store_packer/releases/tag/${PACKER_RELEASE_TAG}`,
        upload_url: 'https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets{?name,label}',
        assets: [
          { id: 199, name: 'release-plan.json', url: 'https://api.github.com/assets/199', browser_download_url: 'https://example.test/release-plan.json' }
        ]
      });
    }

    if (String(url) === `https://api.github.com/repos/HagiCode-org/win_store_packer/releases/assets/99` && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    if (String(url).startsWith('https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets') && method === 'POST') {
      return Response.json({
        id: 120,
        name: new URL(String(url)).searchParams.get('name'),
        browser_download_url: `https://example.test/${new URL(String(url)).searchParams.get('name')}`
      });
    }

    if (String(url) === DESKTOP_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: 'v0.3.0',
            assets: ['v0.3.0/hagicode.desktop.0.3.0-unpacked.zip']
          }
        ]
      });
    }

    if (String(url) === SERVER_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: '0.1.0-beta.34',
            assets: ['0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip']
          }
        ],
        dlcs: [
          {
            dlcName: 'turbo-engine',
            versions: [
              {
                version: '0.1.0-beta.48',
                artifacts: [
                  {
                    name: 'hagicode-dlc-turbo-engine-0.1.0-beta.48-win-x64-nort.zip',
                    path: 'turbo-engine/0.1.0-beta.48/hagicode-dlc-turbo-engine-0.1.0-beta.48-win-x64-nort.zip'
                  }
                ]
              }
            ]
          }
        ]
      });
    }

    if (String(url) === DLC_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        dlcs: [
          {
            dlcName: 'turbo-engine',
            versions: [
              {
                version: '0.1.0-beta.48',
                artifacts: [
                  {
                    name: 'hagicode-dlc-turbo-engine-0.1.0-beta.48-win-x64-nort.zip',
                    path: 'turbo-engine/0.1.0-beta.48/hagicode-dlc-turbo-engine-0.1.0-beta.48-win-x64-nort.zip'
                  }
                ]
              }
            ]
          }
        ]
      });
    }

    if (String(url) === 'https://api.github.com/assets/199') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
    }

    throw new Error(`Unexpected fetch URL: ${url} (${method})`);
  };
}

test('syncReleasePlan replaces the existing draft release-plan asset with a validated plan', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-sync-plan-'));
  const outputPath = path.join(tempRoot, 'release-plan.json');
  const requests = [];

  const result = await syncReleasePlan({
    eventName: 'schedule',
    eventPayload: {},
    outputPath,
    token: 'test-token',
    repositories: {
      packer: 'HagiCode-org/win_store_packer'
    },
    desktopAzureSasUrl: DESKTOP_AZURE_SAS_URL,
    serverAzureSasUrl: SERVER_AZURE_SAS_URL,
    dlcAzureSasUrl: DLC_AZURE_SAS_URL,
    fetchImpl: createSyncFetchStub({ requests })
  });

  assert.equal(result.state, 'synced');
  assert.equal(result.didSync, true);
  assert.equal(result.assetAction, 'replaced');
  assert.equal(result.plan.release.tag, PACKER_RELEASE_TAG);
  assert.equal(result.plan.handoff.assetName, 'release-plan.json');
  assert.equal(result.plan.upstream.desktop.checkoutRef, 'main');

  const writtenPlan = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(writtenPlan.release.tag, PACKER_RELEASE_TAG);
  assert.ok(requests.some((request) => request.url.endsWith('/releases/assets/99') && request.method === 'DELETE'));
  assert.ok(requests.some((request) => request.url.startsWith('https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets') && request.method === 'POST'));
});

test('syncReleasePlan surfaces a missing draft release explicitly', async () => {
  const result = await syncReleasePlan({
    eventName: 'schedule',
    eventPayload: {},
    token: 'test-token',
    repositories: {
      packer: 'HagiCode-org/win_store_packer'
    },
    desktopAzureSasUrl: DESKTOP_AZURE_SAS_URL,
    serverAzureSasUrl: SERVER_AZURE_SAS_URL,
    dlcAzureSasUrl: DLC_AZURE_SAS_URL,
    fetchImpl: createSyncFetchStub({ includeDraft: false })
  });

  assert.deepEqual(result, {
    state: 'no_draft_release',
    didSync: false,
    assetName: 'release-plan.json'
  });
});

test('syncReleasePlan falls back to the Server Azure SAS URL for DLC discovery', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-sync-plan-dlc-fallback-'));
  const outputPath = path.join(tempRoot, 'release-plan.json');

  const result = await syncReleasePlan({
    eventName: 'schedule',
    eventPayload: {},
    outputPath,
    token: 'test-token',
    repositories: {
      packer: 'HagiCode-org/win_store_packer'
    },
    desktopAzureSasUrl: DESKTOP_AZURE_SAS_URL,
    serverAzureSasUrl: SERVER_AZURE_SAS_URL,
    fetchImpl: createSyncFetchStub()
  });

  assert.equal(
    result.plan.upstream.dlcs['turbo-engine'].manifestUrl,
    'https://example.blob.core.windows.net/server/index.json?<sas-token-redacted>'
  );
});

test('downloadReleasePlan fails when the published release is missing release-plan.json', async () => {
  await assert.rejects(
    () => downloadReleasePlan({
      repository: 'HagiCode-org/win_store_packer',
      releaseTag: PACKER_RELEASE_TAG,
      outputPath: path.join(os.tmpdir(), 'missing-release-plan.json'),
      token: 'test-token',
      fetchImpl: async (url) => {
        if (String(url) === `https://api.github.com/repos/HagiCode-org/win_store_packer/releases/tags/${encodeURIComponent(PACKER_RELEASE_TAG)}`) {
          return Response.json({
            id: 42,
            tag_name: PACKER_RELEASE_TAG,
            draft: false,
            upload_url: 'https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets{?name,label}',
            assets: []
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      }
    }),
    /missing required asset release-plan\.json/i
  );
});
