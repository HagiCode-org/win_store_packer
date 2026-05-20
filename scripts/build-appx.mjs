#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanDir, copyDir, ensureDir, listFilesRecursively, pathExists, readJson, writeJson, copySingleFile } from './lib/fs-utils.mjs';
import { createArchive } from './lib/archive.mjs';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { runCommand } from './lib/command.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { buildStoreArtifactName } from './lib/platforms.mjs';
import { loadStorePackageConfig } from './lib/store-config.mjs';
import { writeStoreElectronBuilderConfig } from './lib/appx-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runShellCommand(commandText, cwd) {
  if (process.platform === 'win32') {
    await runCommand('powershell.exe', ['-NoLogo', '-NonInteractive', '-Command', commandText], { cwd });
    return;
  }

  await runCommand('/bin/bash', ['-lc', commandText], { cwd });
}

async function createSyntheticAppx({
  appxPath,
  desktopWorkspace,
  runtimeInjectionRoot,
  packageIdentity
}) {
  const stagingRoot = path.join(path.dirname(appxPath), '.synthetic-appx');
  await cleanDir(stagingRoot);
  await ensureDir(path.join(stagingRoot, 'extra', 'portable-fixed'));
  await copyDir(runtimeInjectionRoot, path.join(stagingRoot, 'extra', 'portable-fixed', 'current'));
  await writeJson(path.join(stagingRoot, 'store-package-identity.json'), packageIdentity);
  await createArchive(stagingRoot, appxPath);
}

async function findAppxOutputs(pkgDirectory) {
  if (!(await pathExists(pkgDirectory))) {
    return [];
  }

  const files = await listFilesRecursively(pkgDirectory);
  return files.filter((filePath) => filePath.toLowerCase().endsWith('.appx')).sort();
}

export async function buildAppx({
  planPath,
  workspacePath,
  platformId,
  forceDryRun = false,
  desktopBuildCommand
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  const pkgDirectory = path.join(workspaceManifest.desktopWorkspace, 'pkg');
  await ensureDir(pkgDirectory);
  const overlayConfig = await writeStoreElectronBuilderConfig({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    sourceConfigPath: storePackageConfig.desktop.electronBuilderConfigPath,
    outputConfigPath: 'electron-builder.store.yml'
  });

  const packageLockPath = path.join(workspaceManifest.desktopWorkspace, 'package-lock.json');
  if (!forceDryRun && await pathExists(packageLockPath)) {
    await runCommand(npmCommand(), ['ci'], { cwd: workspaceManifest.desktopWorkspace });
  }

  if (forceDryRun) {
    await createSyntheticAppx({
      appxPath: path.join(pkgDirectory, buildStoreArtifactName(plan.release.tag, platformId)),
      desktopWorkspace: workspaceManifest.desktopWorkspace,
      runtimeInjectionRoot: workspaceManifest.runtimeInjectionRoot,
      packageIdentity: storePackageConfig.packageIdentity
    });
  } else if (desktopBuildCommand) {
    await runShellCommand(desktopBuildCommand, workspaceManifest.desktopWorkspace);
  } else {
    await runCommand(npmCommand(), ['run', storePackageConfig.desktop.buildScript, '--', '--config', path.basename(overlayConfig.outputPath)], {
      cwd: workspaceManifest.desktopWorkspace,
      env: process.env
    });
  }

  const appxOutputs = await findAppxOutputs(pkgDirectory);
  if (appxOutputs.length === 0) {
    throw new Error(`No .appx outputs were produced under ${pkgDirectory}.`);
  }

  const primaryOutput = appxOutputs[0];
  const artifactFileName = buildStoreArtifactName(plan.release.tag, platformId);
  const artifactPath = path.join(workspaceManifest.outputDirectory, artifactFileName);
  await ensureDir(workspaceManifest.outputDirectory);
  await copySingleFile(primaryOutput, artifactPath);

  const buildMetadata = {
    validationPassed: true,
    platform: platformId,
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    releaseTag: workspaceManifest.releaseTag,
    buildMode: forceDryRun ? 'synthetic-dry-run' : 'desktop-build-script',
    sourceElectronBuilderConfigPath: overlayConfig.sourcePath,
    outputElectronBuilderConfigPath: overlayConfig.outputPath,
    rawAppxOutputs: appxOutputs,
    publishedArtifactPath: artifactPath
  };
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}.json`);
  await writeJson(buildMetadataPath, buildMetadata);

  const artifactRecord = await createArtifactRecord({
    artifactPath,
    platformId,
    metadata: {
      desktopVersion: workspaceManifest.desktopVersion,
      desktopTag: workspaceManifest.desktopTag,
      desktopRef: workspaceManifest.desktopRef,
      serverVersion: workspaceManifest.serverVersion
    }
  });
  const artifactInventory = {
    platform: platformId,
    releaseTag: workspaceManifest.releaseTag,
    artifacts: [artifactRecord],
    buildMetadataPath,
    workspaceValidationPath: path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`),
    payloadValidationPath: path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`)
  };
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}.json`);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### AppX build prepared for ${platformId}`,
    `- Release tag: ${workspaceManifest.releaseTag}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Artifact: ${artifactFileName}`,
    `- Build mode: ${buildMetadata.buildMode}`
  ]);

  return {
    artifactInventoryPath,
    buildMetadataPath,
    artifactPath
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean' },
      'desktop-build-command': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('build-appx requires --plan, --platform, and --workspace.');
  }

  const result = await buildAppx({
    planPath: values.plan,
    workspacePath: values.workspace,
    platformId: values.platform,
    forceDryRun: values['force-dry-run'] ?? false,
    desktopBuildCommand: values['desktop-build-command']
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## AppX build failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
