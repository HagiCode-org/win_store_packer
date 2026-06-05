import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createArchive, validateZipPaths } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { buildMsix } from '../scripts/build-msix.mjs';
import { preparePackagingWorkspace } from '../scripts/prepare-packaging-workspace.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKER_RELEASE_TAG = 'v1.4.0';
const NEXT_PACKER_RELEASE_TAG = 'v1.4.1';

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

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previousValue;
}

async function createTaggedDesktopRepo(tempRoot, tag = 'v0.3.0', packageVersion = null) {
  const sourcePath = fixturePath('desktop-source');
  const repoPath = path.join(tempRoot, 'hagicode-desktop');
  await cp(sourcePath, repoPath, { recursive: true });

  if (packageVersion) {
    const packageJsonPath = path.join(repoPath, 'package.json');
    const packageLockPath = path.join(repoPath, 'package-lock.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8'));

    packageJson.version = packageVersion;
    packageLock.version = packageVersion;
    if (packageLock.packages?.['']) {
      packageLock.packages[''].version = packageVersion;
    }

    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
    await writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
  }

  await runCommand('git', ['init'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['add', '.'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['commit', '-m', 'fixture'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['branch', '-M', 'main'], { cwd: repoPath, env: gitEnv() });
  await runCommand('git', ['tag', tag], { cwd: repoPath, env: gitEnv() });
  return repoPath;
}

async function createServerArchive(tempRoot) {
  const sourcePath = fixturePath('server-payload');
  const archivePath = path.join(tempRoot, 'hagicode-0.1.0-beta.34-win-x64-nort.zip');
  await createArchive(sourcePath, archivePath);
  return archivePath;
}

function createPlan(tempRoot, options = {}) {
  const desktopVersion = options.desktopVersion ?? 'v0.3.1';
  const desktopTag = options.desktopTag ?? desktopVersion;
  const desktopBaseVersion = options.desktopBaseVersion ?? 'v0.3.0';
  const desktopBaseTag = options.desktopBaseTag ?? desktopBaseVersion;
  const desktopCheckoutRef = options.desktopCheckoutRef ?? 'main';
  const desktopCheckoutType = options.desktopCheckoutType ?? 'branch';
  const desktopAssetsByPlatform = options.desktopAssetsByPlatform ?? {};
  const publicationMode = options.publicationMode ?? 'github-release';
  const handoffSource = options.handoffSource ?? (publicationMode === 'workflow-artifact' ? 'workflow-artifact' : 'draft-release-asset');
  const producerWorkflow = options.producerWorkflow ?? (publicationMode === 'workflow-artifact' ? 'package-release' : 'sync-version-plan');
  const releaseTag = options.releaseTag ?? PACKER_RELEASE_TAG;

  return {
    repositories: {
      desktop: 'https://index.hagicode.com/desktop/index.json',
      server: 'https://index.hagicode.com/server/index.json',
      packer: 'HagiCode-org/win_store_packer'
    },
    platforms: ['win-x64'],
    platformMatrix: {
      include: [{ platform: 'win-x64', runner: 'windows-2025', runtimeKey: 'win-x64-nort' }]
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
        sourceMode: 'main',
        manifestUrl: 'https://index.hagicode.com/desktop/index.json',
        version: desktopVersion,
        tag: desktopTag,
        baseVersion: desktopBaseVersion,
        baseTag: desktopBaseTag,
        checkoutRef: desktopCheckoutRef,
        checkoutType: desktopCheckoutType,
        assetsByPlatform: desktopAssetsByPlatform
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
      supportedWindowsTargets: ['win-x64'],
      desktop: {
        storeConfigPath: 'config/store-package.json',
        buildCommand: 'build:win:store',
        runtimeInjectionPath: 'resources/portable-fixed/current'
      }
    },
    publication: {
      mode: publicationMode
    },
    release: {
      repository: 'HagiCode-org/win_store_packer',
      tag: releaseTag,
      name: `Windows Store ${releaseTag}`,
      canonicalVersionInput: releaseTag,
      windowsStoreVersion: releaseTag,
      versionSource: 'release-drafter-packer-tag'
    },
    build: {
      shouldBuild: true,
      forceRebuild: false,
      dryRun: options.dryRun ?? true,
      skipReason: null
    },
    handoff: {
      schema: 'win-store-packer-handoff/v1',
      producer: { repository: 'HagiCode-org/win_store_packer', workflow: producerWorkflow },
      consumer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      assetName: 'release-plan.json',
      source: handoffSource
    }
  };
}

test('dry-run packaging assembles the tagged workspace, stages the server payload, builds a Store package, and emits publication metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-packaging-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot, 'v0.3.0', '0.1.0');
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
    path.join(repoRoot, 'scripts', 'build-msix.mjs'),
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
  const buildMetadata = await readJson(path.join(workspacePath, 'build-metadata-win-x64-unsigned.json'));
  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-win-x64-unsigned.json'));
  const dryRunReport = await readJson(path.join(publishOutputDir, `${PACKER_RELEASE_TAG}.publish-dry-run.json`));
  const releaseMetadata = await readJson(path.join(publishOutputDir, `${PACKER_RELEASE_TAG}.release-metadata.json`));
  const desktopBuildMetadata = await readJson(buildMetadata.desktopBuildMetadataPath);

  assert.equal(workspaceManifest.desktopTag, 'v0.3.1');
  assert.equal(workspaceManifest.desktopCheckoutRef, 'main');
  assert.equal(workspaceManifest.desktopCheckoutType, 'branch');
  assert.equal(workspaceManifest.desktopBaseVersion, 'v0.3.0');
  assert.equal(workspaceManifest.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(workspaceManifest.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(workspaceManifest.desktopBuildCommand, 'build:win:store');
  assert.equal(workspaceManifest.desktopStoreConfigRelativePath, 'config/store-package.json');
  assert.equal((await readJson(workspaceManifest.packageJsonPath)).version, '0.3.1');
  assert.equal((await readJson(workspaceManifest.packageJsonPath)).hagicodeDesktop.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(workspaceReport.validationPassed, true);
  assert.equal(workspaceReport.checks.desktopBuildContractPresent, true);
  assert.equal(workspaceReport.buildStrategy.supported, true);
  assert.equal(workspaceReport.buildStrategy.buildCommand, 'build:win:store');
  assert.equal(payloadReport.validationPassed, true);
  assert.ok(payloadReport.payloadRootForDesktopBuild);
  assert.equal(buildMetadata.validationPassed, true);
  assert.equal(buildMetadata.artifactVariant, 'unsigned');
  assert.equal(buildMetadata.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(buildMetadata.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(buildMetadata.storeConfigPath.endsWith('config/store-package.json'), true);
  assert.equal(buildMetadata.storePackageVersion, '1.4.0.0');
  assert.equal(buildMetadata.desktopBuildMode, 'desktop-store-build-dry-run');
  assert.equal(buildMetadata.signing.mode, 'disabled');
  assert.equal(desktopBuildMetadata.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(inventory.artifacts.length, 1);
  assert.equal(inventory.artifactVariant, 'unsigned');
  assert.equal(inventory.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(inventory.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(inventory.artifacts[0].desktopProduced, true);
  assert.equal(inventory.artifacts[0].windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(inventory.artifacts[0].variant, 'unsigned');
  assert.equal(inventory.artifacts[0].primaryForStoreSubmission, true);
  assert.equal(inventory.artifacts[0].storePackageVersion, '1.4.0.0');
  assert.equal(dryRunReport.releaseTag, PACKER_RELEASE_TAG);
  assert.equal(dryRunReport.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(dryRunReport.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(dryRunReport.desktopVersion, 'v0.3.1');
  assert.equal(dryRunReport.desktopTag, 'v0.3.1');
  assert.equal(dryRunReport.storePackageVersion, '1.4.0.0');
  assert.equal(releaseMetadata.canonicalVersionInput, PACKER_RELEASE_TAG);
  assert.equal(releaseMetadata.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(releaseMetadata.storePackageVersion, '1.4.0.0');
  assert.equal(releaseMetadata.desktop.windowsStoreVersion, PACKER_RELEASE_TAG);
  assert.equal(releaseMetadata.desktop.baseVersion, 'v0.3.0');
  assert.equal(releaseMetadata.desktop.checkoutRef, 'main');
  assert.equal(releaseMetadata.desktop.storeConfigPath.endsWith('config/store-package.json'), true);

  const storePackagePath = inventory.artifacts[0].outputPath;
  const storePackageListing = (await validateZipPaths(storePackagePath)).join('\n');
  assert.match(storePackageListing, /extra\/portable-fixed\/current\/manifest\.json/);
  assert.match(storePackageListing, /extra\/portable-fixed\/current\/lib\/PCode\.Web\.dll/);
  assert.match(storePackageListing, /Package\.appxmanifest|store-package-identity\.json/);
  assert.equal(path.basename(storePackagePath), 'hagicode-store-v1.4.0-win-x64-unsigned.msix');

  const overlayConfig = await readJson(path.join(workspaceManifest.desktopWorkspace, 'forge.store.unsigned.json'));
  assert.equal(overlayConfig.extends, 'forge.config.js');
  assert.equal(overlayConfig.buildVersion, '1.4.0.0');
  assert.equal(overlayConfig.packageIdentity.identityName, 'newbe36524.Hagicode');
  assert.deepEqual(overlayConfig.msix.capabilities, [
    'runFullTrust',
    'internetClient',
    'internetClientServer',
    'privateNetworkClientServer'
  ]);
  assert.match(storePackagePath, /\.msix$/);
});

test('workflow-artifact packaging can build from desktop main using the next Desktop revision as the packaged version', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-main-packaging-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot, 'v0.3.0', '0.1.0');
  const serverArchivePath = await createServerArchive(tempRoot);
  await writeJson(planPath, createPlan(tempRoot, {
    desktopVersion: 'v0.3.1',
    desktopTag: 'v0.3.1',
    desktopBaseVersion: 'v0.3.0',
    desktopBaseTag: 'v0.3.0',
    desktopCheckoutRef: 'main',
    desktopCheckoutType: 'branch',
    desktopAssetsByPlatform: {},
    publicationMode: 'workflow-artifact',
    handoffSource: 'workflow-artifact',
    producerWorkflow: 'package-release',
    dryRun: false,
    releaseTag: NEXT_PACKER_RELEASE_TAG
  }));

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
    path.join(repoRoot, 'scripts', 'build-msix.mjs'),
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
  const buildMetadata = await readJson(path.join(workspacePath, 'build-metadata-win-x64-unsigned.json'));
  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-win-x64-unsigned.json'));
  const releaseMetadata = await readJson(path.join(publishOutputDir, `${NEXT_PACKER_RELEASE_TAG}.release-metadata.json`));

  assert.equal(workspaceManifest.desktopCheckoutRef, 'main');
  assert.equal(workspaceManifest.desktopCheckoutType, 'branch');
  assert.equal(workspaceManifest.desktopVersion, 'v0.3.1');
  assert.equal(workspaceManifest.canonicalVersionInput, NEXT_PACKER_RELEASE_TAG);
  assert.equal(workspaceManifest.windowsStoreVersion, NEXT_PACKER_RELEASE_TAG);
  assert.equal(workspaceManifest.desktopBaseVersion, 'v0.3.0');
  assert.equal((await readJson(workspaceManifest.packageJsonPath)).version, '0.3.1');
  assert.equal((await readJson(workspaceManifest.packageJsonPath)).hagicodeDesktop.windowsStoreVersion, NEXT_PACKER_RELEASE_TAG);
  assert.equal(buildMetadata.desktopVersion, 'v0.3.1');
  assert.equal(buildMetadata.desktopTag, 'v0.3.1');
  assert.equal(buildMetadata.windowsStoreVersion, NEXT_PACKER_RELEASE_TAG);
  assert.equal(buildMetadata.storePackageVersion, '1.4.1.0');
  assert.equal(buildMetadata.desktopBuildMode, 'desktop-store-build-command');
  assert.equal(inventory.windowsStoreVersion, NEXT_PACKER_RELEASE_TAG);
  assert.equal(inventory.storePackageVersion, '1.4.1.0');
  assert.equal(path.basename(inventory.artifacts[0].outputPath), 'hagicode-store-v1.4.1-win-x64-unsigned.msix');
  assert.equal(releaseMetadata.desktop.version, 'v0.3.1');
  assert.equal(releaseMetadata.windowsStoreVersion, NEXT_PACKER_RELEASE_TAG);
  assert.equal(releaseMetadata.desktop.baseVersion, 'v0.3.0');
  assert.equal(releaseMetadata.desktop.checkoutRef, 'main');
  assert.equal(releaseMetadata.publication.mode, 'workflow-artifact');

  const overlayConfig = await readJson(path.join(workspaceManifest.desktopWorkspace, 'forge.store.unsigned.json'));
  assert.equal(overlayConfig.buildVersion, '1.4.1.0');
});

test('unsigned packaging ignores inherited MSIX identity overrides and keeps the desktop Store publisher', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-unsigned-publisher-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot);
  const serverArchivePath = await createServerArchive(tempRoot);
  const previousWindowsPackagePublisher = process.env.WINDOWS_PACKAGE_PUBLISHER;
  const customPublisher = 'CN=Rong Huang, O=Rong Huang, L=Owasso, S=Oklahoma, C=US';
  const officialPublisher = 'CN=8B6C8A94-AAE5-4C8B-9202-A29EA42B042F';

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

  process.env.WINDOWS_PACKAGE_PUBLISHER = customPublisher;

  try {
    await buildMsix({
      planPath,
      workspacePath,
      platformId: 'win-x64',
      artifactVariant: 'unsigned',
      forceDryRun: true,
    });
  } finally {
    restoreEnv('WINDOWS_PACKAGE_PUBLISHER', previousWindowsPackagePublisher);
  }

  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const overlayConfig = await readJson(path.join(workspaceManifest.desktopWorkspace, 'forge.store.unsigned.json'));
  const buildMetadata = await readJson(path.join(workspacePath, 'build-metadata-win-x64-unsigned.json'));
  const desktopBuildMetadata = await readJson(buildMetadata.desktopBuildMetadataPath);

  assert.equal(buildMetadata.signing.mode, 'disabled');
  assert.equal(overlayConfig.packageIdentity.publisher, officialPublisher);
  assert.equal(desktopBuildMetadata.store.publisher, officialPublisher);
  assert.notEqual(overlayConfig.packageIdentity.publisher, customPublisher);
  assert.notEqual(desktopBuildMetadata.store.publisher, customPublisher);
});

test('dry-run packaging preserves PSF-enabled desktop build outputs when the environment is forwarded through win_store_packer', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-psf-packaging-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot, 'v0.3.0', '0.1.0');
  const serverArchivePath = await createServerArchive(tempRoot);
  const previousPsfEnabled = process.env.HAGICODE_ENABLE_PSF;
  const previousPsfDir = process.env.HAGICODE_PSF_DIR;
  const psfDir = path.join(tempRoot, 'psf-bin');
  await writeJson(planPath, createPlan(tempRoot));

  process.env.HAGICODE_ENABLE_PSF = 'true';
  process.env.HAGICODE_PSF_DIR = psfDir;

  try {
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
      path.join(repoRoot, 'scripts', 'build-msix.mjs'),
      '--plan',
      planPath,
      '--platform',
      'win-x64',
      '--workspace',
      workspacePath
    ]);
  } finally {
    restoreEnv('HAGICODE_ENABLE_PSF', previousPsfEnabled);
    restoreEnv('HAGICODE_PSF_DIR', previousPsfDir);
  }

  const desktopBuildMetadata = await readJson(path.join(workspacePath, 'reports', 'desktop-store-build-win-x64-unsigned.json'));
  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-win-x64-unsigned.json'));

  assert.equal(desktopBuildMetadata.psf.enabled, true);
  assert.equal(desktopBuildMetadata.psf.directory, psfDir);
  assert.deepEqual(desktopBuildMetadata.psf.files, [
    'PsfLauncher64.exe',
    'PsfRuntime64.dll',
    'ProcessLauncherFixup64.dll',
    'FileRedirectionFixup64.dll',
  ]);

  const storePackagePath = inventory.artifacts[0].outputPath;
  const storePackageListing = (await validateZipPaths(storePackagePath)).join('\n');
  assert.match(storePackageListing, /config\.json/);
  assert.match(storePackageListing, /PsfLauncher64\.exe/);
  assert.match(storePackageListing, /PsfRuntime64\.dll/);
  assert.match(storePackageListing, /ProcessLauncherFixup64\.dll/);
  assert.match(storePackageListing, /FileRedirectionFixup64\.dll/);
});

test('workspace preparation fails when the plan does not advance beyond the Desktop base tag', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-missing-tag-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopRepoPath = await createTaggedDesktopRepo(tempRoot, 'v0.2.0');
  const plan = createPlan(tempRoot);
  plan.upstream.desktop.tag = 'v0.3.0';
  plan.upstream.desktop.version = 'v0.3.0';
  await writeJson(planPath, plan);

  await assert.rejects(
    () =>
      preparePackagingWorkspace({
        planPath,
        platformId: 'win-x64',
        workspacePath,
        desktopSourcePath: desktopRepoPath
      }),
    /must advance beyond the latest published Desktop release/i
  );
});

test('build-msix fails early when signed packaging is required but Azure signing configuration is missing', async () => {
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
      buildMsix({
        planPath,
        workspacePath,
        platformId: 'win-x64',
        artifactVariant: 'signed',
        signingMode: 'required'
      }),
    /Missing Store signing configuration/
  );
});

test('signed packaging records post-processing signing state without changing the desktop build contract', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-signed-overlay-'));
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

  const previousAzureClientId = process.env.AZURE_CLIENT_ID;
  const previousAzureTenantId = process.env.AZURE_TENANT_ID;
  const previousAzureClientSecret = process.env.AZURE_CLIENT_SECRET;
  const previousAzureEndpoint = process.env.AZURE_CODESIGN_ENDPOINT;
  const previousAzureAccountName = process.env.AZURE_CODESIGN_ACCOUNT_NAME;
  const previousAzureProfileName = process.env.AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME;
  const previousAzureAppxPublisher = process.env.AZURE_CODESIGN_APPX_PUBLISHER;
  const previousWindowsPackagePublisher = process.env.WINDOWS_PACKAGE_PUBLISHER;
  const customPublisher = 'CN=Hagicode Publisher, O=HagiCode, C=US';

  process.env.AZURE_CLIENT_ID = 'client-id';
  process.env.AZURE_TENANT_ID = 'tenant-id';
  process.env.AZURE_CLIENT_SECRET = 'client-secret';
  process.env.AZURE_CODESIGN_ENDPOINT = 'https://example.test';
  process.env.AZURE_CODESIGN_ACCOUNT_NAME = 'account-name';
  process.env.AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME = 'profile-name';
  process.env.AZURE_CODESIGN_APPX_PUBLISHER = customPublisher;
  delete process.env.WINDOWS_PACKAGE_PUBLISHER;

  try {
    await buildMsix({
      planPath,
      workspacePath,
      platformId: 'win-x64',
      artifactVariant: 'signed',
      signingMode: 'required',
      forceDryRun: true
    });
  } finally {
    restoreEnv('AZURE_CLIENT_ID', previousAzureClientId);
    restoreEnv('AZURE_TENANT_ID', previousAzureTenantId);
    restoreEnv('AZURE_CLIENT_SECRET', previousAzureClientSecret);
    restoreEnv('AZURE_CODESIGN_ENDPOINT', previousAzureEndpoint);
    restoreEnv('AZURE_CODESIGN_ACCOUNT_NAME', previousAzureAccountName);
    restoreEnv('AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME', previousAzureProfileName);
    restoreEnv('AZURE_CODESIGN_APPX_PUBLISHER', previousAzureAppxPublisher);
    restoreEnv('WINDOWS_PACKAGE_PUBLISHER', previousWindowsPackagePublisher);
  }

  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const overlayConfig = await readJson(path.join(workspaceManifest.desktopWorkspace, 'forge.store.signed.json'));
  const buildMetadata = await readJson(path.join(workspacePath, 'build-metadata-win-x64-signed.json'));
  const desktopBuildMetadata = await readJson(buildMetadata.desktopBuildMetadataPath);

  assert.equal(overlayConfig.packageIdentity.identityName, 'newbe36524.Hagicode');
  assert.equal(overlayConfig.packageIdentity.publisher, customPublisher);
  assert.equal(Object.hasOwn(overlayConfig, 'azureSignOptions'), false);
  assert.equal(buildMetadata.signing.skipFinalAppxSigning, false);
  assert.equal(buildMetadata.signing.finalArtifactSigningExpected, true);
  assert.equal(buildMetadata.storePackageExtension, '.msix');
  assert.equal(buildMetadata.signing.mode, 'required');
  assert.equal(buildMetadata.signing.status, 'synthetic');
  assert.equal(path.basename(buildMetadata.publishedArtifactPath), 'hagicode-store-v1.4.0-win-x64-signed.msix');
  assert.equal(desktopBuildMetadata.store.publisher, customPublisher);

  const externalSigningBuild = await buildMsix({
    planPath,
    workspacePath,
    platformId: 'win-x64',
    artifactVariant: 'signed',
    signingMode: 'external',
    forceDryRun: true
  });
  const externalSigningMetadata = await readJson(path.join(workspacePath, 'build-metadata-win-x64-signed.json'));

  assert.equal(externalSigningBuild.artifactVariant, 'signed');
  assert.equal(externalSigningMetadata.signing.mode, 'external');
  assert.equal(externalSigningMetadata.signing.enabled, true);
  assert.equal(externalSigningMetadata.signing.finalArtifactSigningExpected, true);
  assert.equal(externalSigningMetadata.storePackageExtension, '.msix');
  assert.equal(externalSigningMetadata.signing.status, 'synthetic');
  assert.equal(path.basename(externalSigningMetadata.publishedArtifactPath), 'hagicode-store-v1.4.0-win-x64-signed.msix');
});
