import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { main } from '../scripts/resolve-release-plan.mjs';
import { buildPlan } from '../scripts/lib/build-plan.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';

function stubArgv(...args) {
  const previous = process.argv;
  process.argv = ['node', 'resolve-release-plan.mjs', ...args];
  return () => {
    process.argv = previous;
  };
}

const DESKTOP_INDEX_URL = 'https://index.hagicode.com/desktop/index.json';
const SERVER_INDEX_URL = 'https://index.hagicode.com/server/index.json';
const DLC_INDEX_URL = 'https://index.hagicode.com/dlc/index.json';
const DESKTOP_AZURE_SAS_URL = 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token';
const SERVER_AZURE_SAS_URL = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';
const DLC_AZURE_SAS_URL = 'https://example.blob.core.windows.net/dlc?sp=racwl&sig=test-token';

function createFetchStub() {
  return async (url) => {
    if (url === DESKTOP_INDEX_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [{ version: 'v0.3.0', assets: ['v0.3.0/hagicode.desktop.0.3.0-unpacked.zip'] }]
      });
    }
    if (url === SERVER_INDEX_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [{ version: '0.1.0-beta.34', assets: ['0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'] }]
      });
    }
    if (url === DLC_INDEX_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        dlcs: [
          {
            dlcName: 'turbo-engine',
            versions: [
              {
                version: '0.1.0-beta.48',
                artifacts: [
                  { name: 'hagicode-dlc-turbo-engine-0.1.0-beta.48-win-x64-nort.zip', path: 'turbo-engine/0.1.0-beta.48/hagicode-dlc-turbo-engine-0.1.0-beta.48-win-x64-nort.zip' }
                ]
              }
            ]
          }
        ]
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

async function buildProducerPlan() {
  return buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: { packer_release_tag: 'v0.2.4' } },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      dlc: DLC_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      server: SERVER_AZURE_SAS_URL,
      dlc: DLC_AZURE_SAS_URL
    },
    findStoreRelease: async () => null,
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });
}

async function withTempPlan(asyncHandler) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-resolve-plan-'));
  const planPath = path.join(tempRoot, 'release-plan.json');
  try {
    await asyncHandler(planPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('resolve-release-plan rewrites a stale downloaded plan with the external expected release tag', async () => {
  await withTempPlan(async (planPath) => {
    // Simulate the exact failure: a producer plan from a previous release (v0.2.4)
    // is attached to the now-published release, but the external event tag is v0.3.0.
    const stalePlan = await buildProducerPlan();
    await writeJson(planPath, stalePlan);

    const restoreArgv = stubArgv('--plan', planPath, '--expected-release-tag', 'v0.3.0');
    try {
      await main();
    } finally {
      restoreArgv();
    }

    const rewritten = await readJson(planPath);
    assert.equal(rewritten.release.tag, 'v0.3.0');
    assert.equal(rewritten.release.name, 'Windows Store v0.3.0');
    assert.equal(rewritten.release.notesTitle, 'Windows Store v0.3.0');
    assert.equal(rewritten.release.canonicalVersionInput, 'v0.2.4');
    assert.equal(rewritten.release.windowsStoreVersion, 'v0.2.4');
  });
});

test('resolve-release-plan fails when no external release tag is provided', async () => {
  await withTempPlan(async (planPath) => {
    const stalePlan = await buildProducerPlan();
    await writeJson(planPath, stalePlan);

    const restoreArgv = stubArgv('--plan', planPath);
    try {
      await assert.rejects(main(), /expected-release-tag/i);
    } finally {
      restoreArgv();
    }

    // The downloaded plan must be left untouched when the gate rejects it.
    const untouched = await readJson(planPath);
    assert.equal(untouched.release.tag, undefined);
  });
});
