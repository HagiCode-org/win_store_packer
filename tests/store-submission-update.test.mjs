import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildStoreSubmissionUpdate } from '../scripts/build-store-submission-update.mjs';
import { writeJson } from '../scripts/lib/fs-utils.mjs';

const PACKER_RELEASE_TAG = 'v1.4.0';

test('buildStoreSubmissionUpdate maps published store package assets into a Store submission payload', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-submission-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const releaseMetadataDir = path.join(tempRoot, 'release-metadata');
  const outputPath = path.join(tempRoot, 'store-submission-update.json');

  await writeJson(planPath, {
    platforms: ['win-x64'],
    downloads: {
      desktop: {},
      server: {}
    },
    upstream: {
      desktop: {
        version: 'v0.3.0',
        tag: 'v0.3.0',
        manifestUrl: 'https://index.hagicode.com/desktop/index.json',
        assetsByPlatform: {
          'win-x64': {
            name: 'hagicode.desktop.0.3.0-unpacked.zip',
            path: 'v0.3.0/hagicode.desktop.0.3.0-unpacked.zip'
          }
        }
      },
      server: {
        version: '0.1.0-beta.34',
        manifestUrl: 'https://index.hagicode.com/server/index.json',
        assetsByPlatform: {
          'win-x64': {
            name: 'hagicode-0.1.0-beta.34-win-x64-nort.zip',
            path: '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
          }
        }
      }
    },
    store: {
      supportedWindowsTargets: ['win-x64'],
      desktop: {
        storeConfigPath: 'config/store-package.json',
        buildCommand: 'build:win:store',
        runtimeInjectionPath: 'resources/portable-fixed/current'
      }
    },
    release: {
      repository: 'HagiCode-org/win_store_packer',
      tag: PACKER_RELEASE_TAG,
      name: `Windows Store ${PACKER_RELEASE_TAG}`,
      canonicalVersionInput: PACKER_RELEASE_TAG,
      windowsStoreVersion: PACKER_RELEASE_TAG,
      versionSource: 'release-drafter-packer-tag'
    },
    build: {
      shouldBuild: true,
      forceRebuild: false,
      dryRun: false
    },
    handoff: {
      schema: 'win-store-packer-handoff/v1',
      producer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      consumer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' }
    }
  });

  await writeJson(path.join(releaseMetadataDir, `${PACKER_RELEASE_TAG}.release-metadata.json`), {
    releaseTag: PACKER_RELEASE_TAG,
    storePackageVersion: '1.4.0.0',
    publication: {
      submissionReadyVariant: 'unsigned'
    },
    artifacts: [
      {
        platform: 'win-x64',
        fileName: 'hagicode-store-v1.4.0-win-x64-unsigned.msix',
        variant: 'unsigned',
        signed: false,
        languages: ['en-US', 'zh-CN']
      },
      {
        platform: 'win-x64',
        fileName: 'hagicode-store-v1.4.0-win-x64-signed.msix',
        variant: 'signed',
        signed: true,
        languages: ['en-US', 'zh-CN']
      },
      {
        platform: 'win-x64',
        fileName: `${PACKER_RELEASE_TAG}.release-metadata.json`
      }
    ]
  });

  await writeJson(path.join(releaseMetadataDir, `${PACKER_RELEASE_TAG}.publication-result.json`), {
    dryRun: false,
    releaseTag: PACKER_RELEASE_TAG,
    uploadedAssets: [
      {
        name: 'hagicode-store-v1.4.0-win-x64-unsigned.msix',
        url: `https://github.com/HagiCode-org/win_store_packer/releases/download/${PACKER_RELEASE_TAG}/hagicode-store-v1.4.0-win-x64-unsigned.msix`
      },
      {
        name: 'hagicode-store-v1.4.0-win-x64-signed.msix',
        url: `https://github.com/HagiCode-org/win_store_packer/releases/download/${PACKER_RELEASE_TAG}/hagicode-store-v1.4.0-win-x64-signed.msix`
      },
      {
        name: `${PACKER_RELEASE_TAG}.release-metadata.json`,
        url: 'https://example.test/metadata.json'
      }
    ]
  });

  const result = await buildStoreSubmissionUpdate({
    planPath,
    releaseMetadataDir,
    outputPath
  });

  assert.deepEqual(result.payload, {
    packages: [
      {
        packageUrl: `https://github.com/HagiCode-org/win_store_packer/releases/download/${PACKER_RELEASE_TAG}/hagicode-store-v1.4.0-win-x64-unsigned.msix`,
        languages: ['en-US', 'zh-CN'],
        architectures: ['X64']
      }
    ]
  });
});
