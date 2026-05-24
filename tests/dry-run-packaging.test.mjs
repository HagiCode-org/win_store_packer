import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { createArchive, validateZipPaths } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { buildAppx } from '../scripts/build-appx.mjs';
import { preparePackagingWorkspace } from '../scripts/prepare-packaging-workspace.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixturePath(...segments) {
  return path.join(repoRoot, 'tests', 'fixtures', ...segments);
}

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Copilot',
    GIT_AUTHOR_EMAIL: 'copilot@example.com',
    GIT_COMMITTER_NAME: 'Copilot',
    GIT_COMMITTER_EMAIL: 'copilot@example.com'
  };
}

async function createTaggedDesktopRepo(tempRoot, tag = 'v0.3.0') {
  const sourcePath = fixturePath('desktop-source');
  const repoPath = path.join(tempRoot, 'hagicode-desktop');
  await cp(sourcePath, repoPath, { recursive: true });
  await runCommand('git', ['init'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['add', '.'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['commit', '-m', 'fixture'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['tag', tag], { cwd: repoPath, env: gitEnv() });
  return repoPath;
}

async function createServerArchive(tempRoot) {
  const sourcePath = fixturePath('server-payload');
  const archivePath = path.join(tempRoot, 'hagicode-0.1.0-beta.34-win-x64-nort.zip');
  await createArchive(sourcePath, archivePath);
  return archivePath;
}

function createPlan(tempRoot) {
  return {
    repositories: {
      desktop: 'https://index.hagicode.com/desktop/index.json',
      server: 'https://index.hagicode.com/server/index.json',
      packer: 'HagiCode-org/win_store_packer'
    },
    platforms: ['win-x64'],
    platformMatrix: {
      include: [{ platform: 'win-x64', runner: 'windows-latest', runtimeKey: 'win-x64-nort' }]
    },
    downloads: {
      strategy: 'azure-blob-sas',
      desktop: {
        containerUrl: 'https://example.blob.core.windows.net/desktop/'
      },
      server: {
        containerUrl: 'https://example.blob.core.windows.net/server/'
      }
    },
    upstream: {
      desktop: {
        sourceType: 'index',
        manifestUrl: 'https://index.hagicode.com/desktop/index.json',
        version: 'v0.3.0',
        tag: 'v0.3.0',
        assetsByPlatform: {
          'win-x64': {
            name: 'hagicode.desktop.0.3.0-unpacked.zip',
            path: 'v0.3.0/hagicode.desktop.0.3.0-unpacked.zip'
          }
        }
      },
      server: {
        sourceType: 'index',
        manifestUrl: 'https://index.hagicode.com/server/index.json',
        version: '0.1.0-beta.34',
        assetsByPlatform: {
          'win-x64': {
            name: 'hagicode-0.1.0-beta.34-win-x64-nort.zip',
            path: '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
          }
        }
      }
    },
    store: {
      packageIdentity: {
        displayName: 'Hagicode',
        publisherDisplayName: 'newbe36524',
        publisher: 'CN=8B6C8A94-AAE5-4C8B-9202-A29EA42B042F',
        identityName: 'newbe36524.Hagicode',
        backgroundColor: 'transparent',
        languages: ['en-US'],
        addAutoLaunchExtension: false
      },
      supportedWindowsTargets: ['win-x64']
    },
    release: {
      repository: 'HagiCode-org/win_store_packer',
      tag: 'store-desktop-v0.3.0-server-v0.1.0-beta.34',
      name: 'Windows Store store-desktop-v0.3.0-server-v0.1.0-beta.34'
    },
    build: {
      shouldBuild: true,
      forceRebuild: false,
      dryRun: true,
      skipReason: null
    },
    handoff: {
      schema: 'win-store-packer-handoff/v1',
      producer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      consumer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' }
    }
  };
}

test('dry-run packaging assembles the tagged workspace, stages the server payload, builds an msix, and emits publication metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-packaging-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot);
  const serverArchivePath = await createServerArchive(tempRoot);
  await writeJson(planPath, createPlan(tempRoot));

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'prepare-packaging-workspace.mjs'),
    '--plan',
    planPath,
    '--platform',
    'win-x64',
    '--workspace',
    workspacePath,
    '--desktop-source',
    desktopRepoPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-server-payload.mjs'),
    '--plan',
    planPath,
    '--platform',
    'win-x64',
    '--workspace',
    workspacePath,
    '--server-asset-source',
    serverArchivePath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'build-appx.mjs'),
    '--plan',
    planPath,
    '--platform',
    'win-x64',
    '--workspace',
    workspacePath
  ]);

  const publishOutputDir = path.join(tempRoot, 'release-metadata');
  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'publish-release.mjs'),
    '--plan',
    planPath,
    '--artifacts-dir',
    workspacePath,
    '--output-dir',
    publishOutputDir,
    '--force-dry-run'
  ]);

  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const workspaceReport = await readJson(path.join(workspacePath, 'workspace-validation-win-x64.json'));
  const payloadReport = await readJson(path.join(workspacePath, 'payload-validation-win-x64.json'));
  const buildMetadata = await readJson(path.join(workspacePath, 'build-metadata-win-x64.json'));
  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-win-x64.json'));
  const dryRunReport = await readJson(path.join(publishOutputDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.publish-dry-run.json'));
  const releaseMetadata = await readJson(path.join(publishOutputDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json'));

  assert.equal(workspaceManifest.desktopTag, 'v0.3.0');
  assert.equal(workspaceReport.validationPassed, true);
  assert.equal(workspaceReport.checks.desktopBuildPipelineSupported, true);
  assert.equal(workspaceReport.buildStrategy.supported, true);
  assert.equal(payloadReport.validationPassed, true);
  assert.equal(buildMetadata.validationPassed, true);
  assert.equal(buildMetadata.distributionMode, 'steam');
  assert.equal(buildMetadata.runtimeSource, 'portable-fixed');
  assert.equal(buildMetadata.storePackageVersion, '0.3.0.0');
  assert.equal(buildMetadata.buildMode, 'desktop-build-pipeline');
  assert.equal(buildMetadata.signing.mode, 'disabled');
  assert.equal(inventory.artifacts.length, 1);
  assert.equal(inventory.artifacts[0].distributionMode, 'steam');
  assert.equal(inventory.artifacts[0].runtimeSource, 'portable-fixed');
  assert.equal(inventory.artifacts[0].variant, 'unsigned');
  assert.equal(inventory.artifacts[0].storePackageVersion, '0.3.0.0');
  assert.equal(dryRunReport.releaseTag, 'store-desktop-v0.3.0-server-v0.1.0-beta.34');
  assert.equal(dryRunReport.distributionMode, 'steam');
  assert.equal(dryRunReport.runtimeSource, 'portable-fixed');
  assert.equal(dryRunReport.desktopTag, 'v0.3.0');
  assert.equal(dryRunReport.storePackageVersion, '0.3.0.0');
  assert.equal(releaseMetadata.distributionMode, 'steam');
  assert.equal(releaseMetadata.runtimeSource, 'portable-fixed');
  assert.equal(releaseMetadata.storePackageVersion, '0.3.0.0');

  const msixPath = inventory.artifacts[0].outputPath;
  const msixListing = (await validateZipPaths(msixPath)).join('\n');
  assert.match(msixListing, /extra\/portable-fixed\/current\/manifest\.json/);
  assert.match(msixListing, /extra\/portable-fixed\/current\/lib\/PCode\.Web\.dll/);
  assert.match(msixListing, /AppxManifest\.xml|store-package-identity\.json/);

  const overlayConfigText = await readFile(path.join(workspaceManifest.desktopWorkspace, 'electron-builder.store.yml'), 'utf8');
  assert.match(overlayConfigText, /extends: electron-builder\.yml/);
  assert.match(overlayConfigText, /buildVersion: 0\.3\.0\.0/);
  assert.match(overlayConfigText, /identityName: newbe36524\.Hagicode/);
  assert.match(overlayConfigText, /capabilities:\n(?:    - .+\n)+/);
  assert.match(overlayConfigText, /    - internetClient/);
  assert.match(overlayConfigText, /    - internetClientServer/);
  assert.match(overlayConfigText, /    - privateNetworkClientServer/);
  assert.match(msixPath, /-unsigned\.msix$/);
});

test('workspace preparation fails when the expected desktop tag is missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-missing-tag-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot, 'v0.2.0');
  const plan = createPlan(tempRoot);
  plan.upstream.desktop.tag = 'v0.3.0';
  await writeJson(planPath, plan);

  await assert.rejects(
    () =>
      preparePackagingWorkspace({
        planPath,
        platformId: 'win-x64',
        workspacePath,
        desktopSourcePath: desktopRepoPath
      }),
    /Desktop tag v0\.3\.0 is not available/
  );
});

test('build-appx fails early when signed packaging is required but Azure signing configuration is missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-signing-config-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot);
  const serverArchivePath = await createServerArchive(tempRoot);
  await writeJson(planPath, createPlan(tempRoot));

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'prepare-packaging-workspace.mjs'),
    '--plan',
    planPath,
    '--platform',
    'win-x64',
    '--workspace',
    workspacePath,
    '--desktop-source',
    desktopRepoPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-server-payload.mjs'),
    '--plan',
    planPath,
    '--platform',
    'win-x64',
    '--workspace',
    workspacePath,
    '--server-asset-source',
    serverArchivePath
  ]);

  await assert.rejects(
    () =>
      buildAppx({
        planPath,
        workspacePath,
        platformId: 'win-x64',
        signingMode: 'required'
      }),
    /Missing Store signing configuration/
  );
});
