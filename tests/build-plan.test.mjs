import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
  DEFAULT_PLAN_PRODUCER_WORKFLOW,
  PUBLICATION_MODES,
  RELEASE_PLAN_ASSET_NAME,
  RELEASE_PLAN_HANDOFF_SOURCE,
  WORKFLOW_ARTIFACT_HANDOFF_SOURCE,
  buildPlan
} from '../scripts/lib/build-plan.mjs';
import { readJson } from '../scripts/lib/fs-utils.mjs';
import { validateReleasePlan } from '../scripts/lib/release-plan.mjs';
import { DEFAULT_DLC_PUBLIC_BASE_URL } from '../scripts/lib/artifact-download.mjs';
import { resolveDispatchBuildPlan } from '../scripts/resolve-dispatch-build-plan.mjs';

const DESKTOP_INDEX_URL = 'https://index.hagicode.com/desktop/index.json';
const SERVER_INDEX_URL = 'https://index.hagicode.com/server/index.json';
const DLC_INDEX_URL = 'https://index.hagicode.com/dlc/index.json';
const DESKTOP_AZURE_SAS_URL = 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token';
const SERVER_AZURE_SAS_URL = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';
const DLC_AZURE_SAS_URL = 'https://example.blob.core.windows.net/dlc?sp=racwl&sig=test-token';
const DESKTOP_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/desktop/index.json?sp=racwl&sig=test-token';
const SERVER_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/server/index.json?sp=racwl&sig=test-token';
const DLC_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/dlc/index.json?sp=racwl&sig=test-token';
const DLC_PUBLIC_BASE_URL = 'https://dlc.example.com';
const PACKER_RELEASE_TAG = 'v1.4.0';
const NEXT_PACKER_RELEASE_TAG = 'v1.4.1';
const LEGACY_PACKER_RELEASE_TAG = 'v1.3.9';

function createFetchStub({ requests = [] } = {}) {
  return async (url) => {
    requests.push(url);

    if (url === DESKTOP_INDEX_URL || url === DESKTOP_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: 'v0.2.0',
            assets: ['v0.2.0/hagicode.desktop.0.2.0-unpacked.zip']
          },
          {
            version: 'v0.3.0',
            assets: ['v0.3.0/hagicode.desktop.0.3.0-unpacked.zip']
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
            assets: ['0.1.0-beta.33/hagicode-0.1.0-beta.33-win-x64-nort.zip']
          },
          {
            version: '0.1.0-beta.34',
            assets: ['0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip']
          }
        ]
      });
    }

    if (url === DLC_INDEX_URL || url === DLC_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        dlcs: [
          {
            dlcName: 'turbo-engine',
            versions: [
              {
                version: '0.1.0-beta.47',
                artifacts: [
                  { name: 'hagicode-dlc-turbo-engine-0.1.0-beta.47-win-x64-nort.zip', path: 'turbo-engine/0.1.0-beta.47/hagicode-dlc-turbo-engine-0.1.0-beta.47-win-x64-nort.zip' }
                ]
              },
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

function baseBuildPlanOptions(overrides = {}) {
  return {
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: { packer_release_tag: PACKER_RELEASE_TAG } },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    findStoreRelease: async () => null,
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z',
    ...overrides
  };
}

test('buildPlan resolves a main-only release plan from the latest Desktop and Server versions', async () => {
  const plan = await buildPlan(baseBuildPlanOptions());

  assert.deepEqual(plan.platforms, ['win-x64']);
  assert.equal(plan.trigger.desktopSourceMode, 'main');
  assert.equal(plan.upstream.desktop.sourceMode, 'main');
  assert.equal(plan.upstream.desktop.baseVersion, 'v0.3.0');
  assert.equal(plan.upstream.desktop.baseTag, 'v0.3.0');
  assert.equal(plan.upstream.desktop.version, 'v0.3.0');
  assert.equal(plan.upstream.desktop.tag, 'v0.3.0');
  assert.equal(plan.upstream.desktop.checkoutRef, 'main');
  assert.equal(plan.upstream.desktop.checkoutType, 'branch');
  assert.deepEqual(plan.upstream.desktop.assetsByPlatform, {});
  assert.equal(plan.upstream.server.version, '0.1.0-beta.34');
  assert.equal(plan.upstream.dlcs['turbo-engine'].version, '0.1.0-beta.34');
  assert.equal(plan.upstream.dlcs['turbo-engine'].assetsByPlatform['win-x64'].name, 'hagicode-dlc-turbo-engine-0.1.0-beta.34-win-x64-nort.zip');
  assert.equal(plan.upstream.dlcs['turbo-engine'].sourceType, 'server-version-derived');
  assert.equal(plan.upstream.dlcs['turbo-engine'].assetsByPlatform['win-x64'].path, 'turbo-engine/0.1.0-beta.34/hagicode-dlc-turbo-engine-0.1.0-beta.34-win-x64-nort.zip');
  assert.equal(plan.downloads.dlc.publicBaseUrl, DEFAULT_DLC_PUBLIC_BASE_URL);
  assert.equal(
    plan.upstream.dlcs['turbo-engine'].assetsByPlatform['win-x64'].directUrl,
    `${DEFAULT_DLC_PUBLIC_BASE_URL}/turbo-engine/0.1.0-beta.34/hagicode-dlc-turbo-engine-0.1.0-beta.34-win-x64-nort.zip`
  );
  assert.equal(plan.store.dlcs['turbo-engine'].dlcId, 'pcode.turbo-engine');
  assert.equal(plan.release.tag, undefined);
  assert.equal(plan.release.name, undefined);
  assert.equal(plan.release.notesTitle, undefined);
  assert.equal(plan.release.canonicalVersionInput, undefined);
  assert.equal(plan.release.windowsStoreVersion, undefined);
  assert.equal(plan.release.versionSource, undefined);
  assert.equal(plan.publication.mode, 'github-release');
  assert.equal(plan.build.shouldBuild, true);
  assert.equal(plan.build.forceRebuild, false);
  assert.equal(plan.build.dryRun, false);
  assert.equal(plan.handoff.assetName, RELEASE_PLAN_ASSET_NAME);
  assert.equal(plan.handoff.source, RELEASE_PLAN_HANDOFF_SOURCE);
  assert.equal(plan.handoff.producer.workflow, DEFAULT_PLAN_PRODUCER_WORKFLOW);

  const validated = validateReleasePlan(plan, { expectedReleaseTag: PACKER_RELEASE_TAG });
  assert.equal(validated.releaseTag, PACKER_RELEASE_TAG);
  assert.equal(validated.expectedReleaseTag, PACKER_RELEASE_TAG);
  assert.equal(validated.plan.release.tag, PACKER_RELEASE_TAG);
  assert.equal(validated.plan.release.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(validated.plan.release.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(validated.plan.release.versionSource, 'release-drafter-packer-tag');
  assert.equal(validated.plan.release.name, `Windows Store ${PACKER_RELEASE_TAG}`);
  assert.equal(validated.handoffAssetName, RELEASE_PLAN_ASSET_NAME);
});

test('buildPlan derives DLC R2 asset URLs from the selected server version', async () => {
  const requests = [];
  const plan = await buildPlan(baseBuildPlanOptions({
    publicBaseUrls: { dlc: DLC_PUBLIC_BASE_URL },
    fetchImpl: createFetchStub({ requests })
  }));

  assert.deepEqual(requests, [DESKTOP_INDEX_URL, SERVER_INDEX_URL]);
  assert.equal(plan.repositories.dlc, null);
  assert.equal(plan.downloads.dlc.publicBaseUrl, DLC_PUBLIC_BASE_URL);
  assert.equal(plan.upstream.desktop.manifestUrl, DESKTOP_INDEX_URL);
  assert.equal(plan.upstream.server.manifestUrl, SERVER_INDEX_URL);
  assert.equal(plan.upstream.dlcs['turbo-engine'].manifestUrl, null);
  assert.equal(plan.upstream.dlcs['turbo-engine'].sourceAuthority, 'explicit-override');
  assert.equal(
    plan.upstream.dlcs['turbo-engine'].assetsByPlatform['win-x64'].directUrl,
    `${DLC_PUBLIC_BASE_URL}/turbo-engine/0.1.0-beta.34/hagicode-dlc-turbo-engine-0.1.0-beta.34-win-x64-nort.zip`
  );
});

test('buildPlan accepts legacy Azure SAS index fallback when explicitly supplied', async () => {
  const requests = [];
  const plan = await buildPlan(baseBuildPlanOptions({
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      server: SERVER_AZURE_SAS_URL,
      dlc: DLC_AZURE_SAS_URL
    },
    repositories: {
      packer: 'HagiCode-org/win_store_packer'
    }, 
    fetchImpl: createFetchStub({ requests })
  }));

  assert.deepEqual(requests, [DESKTOP_AZURE_MANIFEST_URL, SERVER_AZURE_MANIFEST_URL, DLC_AZURE_MANIFEST_URL]);
  assert.equal(plan.upstream.desktop.manifestUrl, 'https://example.blob.core.windows.net/desktop/index.json?<sas-token-redacted>');
  assert.equal(plan.upstream.server.manifestUrl, 'https://example.blob.core.windows.net/server/index.json?<sas-token-redacted>');
  assert.equal(plan.upstream.dlcs['turbo-engine'].manifestUrl, 'https://example.blob.core.windows.net/dlc/index.json?<sas-token-redacted>');
  assert.equal(plan.upstream.server.sourceAuthority, 'legacy-azure-sas');
  assert.equal(plan.upstream.dlcs['turbo-engine'].sourceAuthority, 'legacy-azure-sas');
});

test('buildPlan rejects the removed desktop release mode input', async () => {
  await assert.rejects(
    () => buildPlan(baseBuildPlanOptions({
      eventPayload: {
        inputs: {
          packer_release_tag: PACKER_RELEASE_TAG,
          desktop_source: 'release'
        }
      }
    })),
    /Only desktop_source=main is supported/i
  );
});

test('buildPlan rejects Desktop release selectors', async () => {
  await assert.rejects(
    () => buildPlan(baseBuildPlanOptions({
      eventPayload: {
        inputs: {
          packer_release_tag: PACKER_RELEASE_TAG,
          desktop_version: 'v0.2.0'
        }
      }
    })),
    /Desktop release selectors are no longer supported/i
  );
});

test('buildPlan keeps server overrides and dry-run metadata for manual verification', async () => {
  const plan = await buildPlan(baseBuildPlanOptions({
    eventPayload: {
      inputs: {
        packer_release_tag: LEGACY_PACKER_RELEASE_TAG,
        server_version: '0.1.0-beta.33',
        force_rebuild: true,
        dry_run: true
      }
    }
  }));

  assert.equal(plan.upstream.server.version, '0.1.0-beta.33');
  const legacyValidated = validateReleasePlan(plan, { expectedReleaseTag: LEGACY_PACKER_RELEASE_TAG });
  assert.equal(legacyValidated.canonicalVersionInput, LEGACY_PACKER_RELEASE_TAG);
  assert.equal(legacyValidated.windowsStoreVersion, LEGACY_PACKER_RELEASE_TAG);
  assert.equal(plan.build.forceRebuild, true);
  assert.equal(plan.build.dryRun, true);
  assert.equal(plan.build.shouldBuild, true);
});

test('buildPlan supports workflow-artifact main builds for package-release test runs', async () => {
  const plan = await buildPlan(baseBuildPlanOptions({
    eventPayload: {
      inputs: {
        packer_release_tag: NEXT_PACKER_RELEASE_TAG,
      }
    },
    publicationMode: PUBLICATION_MODES.WORKFLOW_ARTIFACT,
    handoffSource: WORKFLOW_ARTIFACT_HANDOFF_SOURCE,
    producerWorkflow: 'package-release'
  }));

  assert.equal(plan.publication.mode, 'workflow-artifact');
  assert.equal(plan.build.dryRun, false);
  assert.equal(plan.release.exists, false);
  assert.equal(plan.handoff.source, 'workflow-artifact');
  assert.equal(plan.handoff.producer.workflow, 'package-release');

  const workflowValidated = validateReleasePlan(plan, {
    expectedReleaseTag: NEXT_PACKER_RELEASE_TAG,
    expectedPublicationMode: 'workflow-artifact',
    expectedHandoffSource: 'workflow-artifact'
  });
  assert.equal(workflowValidated.canonicalVersionInput, NEXT_PACKER_RELEASE_TAG);
  assert.equal(workflowValidated.publicationMode, 'workflow-artifact');
  assert.equal(workflowValidated.handoffSource, 'workflow-artifact');
});

test('buildPlan reports non-JSON index responses without undici JSON parse noise', async () => {
  await assert.rejects(
    () => buildPlan(baseBuildPlanOptions({
      repositories: {
        desktop: DESKTOP_INDEX_URL,
        server: SERVER_INDEX_URL,
        dlc: 'https://index.hagicode.com/dlc/index.json',
        packer: 'HagiCode-org/win_store_packer'
      },
      fetchImpl: async (url) => {
        if (url === 'https://index.hagicode.com/dlc/index.json') {
          return new Response('<!DOCTYPE html><html><title>HagiCode Portal</title></html>', {
            headers: { 'content-type': 'text/html' }
          });
        }

        return createFetchStub()(url);
      }
    })),
    /Index manifest https:\/\/index\.hagicode\.com\/dlc\/index\.json returned text\/html content instead of JSON\./
  );
});

test('validateReleasePlan treats the external release tag as authoritative and injects it back into the plan', async () => {
  const plan = await buildPlan(baseBuildPlanOptions({
    eventPayload: { inputs: { packer_release_tag: NEXT_PACKER_RELEASE_TAG } }
  }));

  const validated = validateReleasePlan(plan, { expectedReleaseTag: PACKER_RELEASE_TAG });
  assert.equal(validated.releaseTag, PACKER_RELEASE_TAG);
  assert.equal(validated.expectedReleaseTag, PACKER_RELEASE_TAG);
  assert.equal(validated.plan.release.tag, PACKER_RELEASE_TAG);
  assert.equal(validated.plan.release.name, `Windows Store ${PACKER_RELEASE_TAG}`);
});

test('validateReleasePlan derives the canonical version from the tag for tagged releases', async () => {
  const plan = await buildPlan(baseBuildPlanOptions({
    eventPayload: { inputs: { packer_release_tag: NEXT_PACKER_RELEASE_TAG } }
  }));

  // Producer must not carry any version snapshot.
  assert.equal(plan.release.canonicalVersionInput, undefined);
  assert.equal(plan.release.windowsStoreVersion, undefined);
  assert.equal(plan.release.versionSource, undefined);

  const validated = validateReleasePlan(plan, { expectedReleaseTag: 'v2.5.7' });
  assert.equal(validated.canonicalVersionInput, 'v2.5.7');
  assert.equal(validated.windowsStoreVersion, 'v2.5.7');
  assert.equal(validated.versionSource, 'release-drafter-packer-tag');
});

test('validateReleasePlan reports the fixed 0.1.0 version for main test builds', async () => {
  const plan = await buildPlan(baseBuildPlanOptions({
    eventPayload: { inputs: { packer_release_tag: 'v0.1.0' } },
    publicationMode: PUBLICATION_MODES.WORKFLOW_ARTIFACT,
    handoffSource: WORKFLOW_ARTIFACT_HANDOFF_SOURCE
  }));

  const validated = validateReleasePlan(plan, {
    expectedReleaseTag: 'v0.1.0',
    expectedPublicationMode: 'workflow-artifact',
    expectedHandoffSource: 'workflow-artifact'
  });
  assert.equal(validated.releaseTag, 'v0.1.0');
  assert.equal(validated.canonicalVersionInput, '0.1.0');
  assert.equal(validated.windowsStoreVersion, '0.1.0');
  assert.equal(validated.plan.release.canonicalVersionInput, '0.1.0');
  assert.equal(validated.plan.release.windowsStoreVersion, '0.1.0');
});

test('validateReleasePlan rejects a plan that is missing both the external and stored release tag', async () => {
  const plan = await buildPlan(baseBuildPlanOptions({
    eventPayload: { inputs: { packer_release_tag: NEXT_PACKER_RELEASE_TAG } }
  }));

  assert.throws(
    () => validateReleasePlan(plan),
    /Release tag is required from external context/i
  );
});

test('validateReleasePlan rejects a mismatched expected publication mode', async () => {
  const plan = await buildPlan(baseBuildPlanOptions());

  assert.throws(
    () => validateReleasePlan(plan, { expectedReleaseTag: PACKER_RELEASE_TAG, expectedPublicationMode: 'workflow-artifact' }),
    /plan\.publication\.mode must be workflow-artifact/i
  );
});

test('validateReleasePlan rejects a missing Turbo Engine DLC asset', async () => {
  const plan = await buildPlan(baseBuildPlanOptions());
  delete plan.upstream.dlcs['turbo-engine'].assetsByPlatform['win-x64'];

  assert.throws(
    () => validateReleasePlan(plan, { expectedReleaseTag: PACKER_RELEASE_TAG }),
    /plan\.upstream\.dlcs."turbo-engine"\.assetsByPlatform\.win-x64/
  );
});

test('resolveDispatchBuildPlan writes the normalized release-plan artifact', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-build-plan-'));
  const outputPath = path.join(tempRoot, 'release-plan.json');

  const result = await resolveDispatchBuildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    outputPath,
    producerWorkflow: 'sync-version-plan',
    packerReleaseTag: PACKER_RELEASE_TAG,
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    dlcPublicBaseUrl: DLC_PUBLIC_BASE_URL,
    findStoreRelease: async () => null,
    fetchImpl: createFetchStub()
  });

  const writtenPlan = await readJson(outputPath);
  assert.equal(writtenPlan.release.tag, undefined);
  assert.equal(writtenPlan.release.canonicalVersionInput, undefined);
  assert.equal(writtenPlan.release.windowsStoreVersion, undefined);
  const dispatchValidated = validateReleasePlan(writtenPlan, { expectedReleaseTag: PACKER_RELEASE_TAG });
  assert.equal(dispatchValidated.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(result.plan.upstream.desktop.checkoutRef, 'main');
  assert.equal(result.plan.upstream.desktop.tag, 'v0.3.0');
  assert.equal(writtenPlan.handoff.assetName, RELEASE_PLAN_ASSET_NAME);
  assert.equal(writtenPlan.handoff.producer.workflow, 'sync-version-plan');
  assert.equal(
    writtenPlan.upstream.dlcs['turbo-engine'].assetsByPlatform['win-x64'].directUrl,
    `${DLC_PUBLIC_BASE_URL}/turbo-engine/0.1.0-beta.34/hagicode-dlc-turbo-engine-0.1.0-beta.34-win-x64-nort.zip`
  );
  assert.equal(writtenPlan.downloads.dlc.publicBaseUrl, DLC_PUBLIC_BASE_URL);
});

test('resolveDispatchBuildPlan can force workflow-artifact main build plans', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-build-plan-artifact-'));
  const outputPath = path.join(tempRoot, 'release-plan.json');

  const result = await resolveDispatchBuildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: { dry_run: false } },
    outputPath,
    producerWorkflow: 'package-release',
    publicationMode: PUBLICATION_MODES.WORKFLOW_ARTIFACT,
    handoffSource: WORKFLOW_ARTIFACT_HANDOFF_SOURCE,
    forceDryRun: true,
    packerReleaseTag: NEXT_PACKER_RELEASE_TAG,
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      server: SERVER_INDEX_URL,
      dlc: DLC_INDEX_URL,
      packer: 'HagiCode-org/win_store_packer'
    },
    findStoreRelease: async () => {
      throw new Error('workflow-artifact mode should not query published releases');
    },
    fetchImpl: createFetchStub()
  });

  assert.equal(result.plan.publication.mode, 'workflow-artifact');
  assert.equal(result.plan.build.dryRun, true);
  assert.equal(result.plan.handoff.source, 'workflow-artifact');
  assert.equal(result.plan.release.exists, false);
});
