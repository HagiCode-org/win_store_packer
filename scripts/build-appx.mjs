#!/usr/bin/env node
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanDir, copyDir, ensureDir, listFilesRecursively, pathExists, readJson, writeJson, copySingleFile } from './lib/fs-utils.mjs';
import { createArchive } from './lib/archive.mjs';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { runCommand } from './lib/command.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { buildStoreArtifactName } from './lib/platforms.mjs';
import {
  buildDesktopStoreCommand,
  buildDesktopStoreSteps,
  resolveDesktopStoreBuildStrategy,
  shouldUseSyntheticDryRunBuild
} from './lib/desktop-build.mjs';
import {
  loadStorePackageConfig,
  normalizeStorePackageVersion,
  normalizeStoreSigningMode,
  resolveStoreSigningConfig
} from './lib/store-config.mjs';
import { writeStoreElectronBuilderConfig } from './lib/appx-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const STORE_PACKAGE_EXTENSIONS = new Set(['.appx', '.msix']);

function normalizeArtifactVariant(value) {
  const normalized = String(value ?? 'unsigned').trim().toLowerCase();
  if (!['unsigned', 'signed'].includes(normalized)) {
    throw new Error(`Unsupported artifact variant ${JSON.stringify(value)}. Expected unsigned or signed.`);
  }
  return normalized;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runShellCommand(commandText, cwd) {
  if (process.platform === 'win32') {
    await runCommand('cmd.exe', ['/d', '/s', '/c', commandText], { cwd });
    return;
  }

  await runCommand('/bin/bash', ['-lc', commandText], { cwd });
}

async function executeDesktopBuildSteps(steps, cwd) {
  for (const [index, step] of steps.entries()) {
    console.log(`[build-appx] step ${index + 1}/${steps.length}: ${step.name}`);
    await runCommand(step.command, step.args, { cwd });
  }
}

async function createSyntheticStorePackage({
  artifactPath,
  runtimeInjectionRoot,
  packageIdentity,
  packageVersion
}) {
  const stagingRoot = path.join(path.dirname(artifactPath), '.synthetic-msix');
  await cleanDir(stagingRoot);
  await ensureDir(path.join(stagingRoot, 'extra', 'portable-fixed'));
  await copyDir(runtimeInjectionRoot, path.join(stagingRoot, 'extra', 'portable-fixed', 'current'));
  await writeJson(path.join(stagingRoot, 'store-package-identity.json'), {
    ...packageIdentity,
    packageVersion
  });
  await createArchive(stagingRoot, artifactPath);
}

async function findStoreOutputs(pkgDirectory) {
  if (!(await pathExists(pkgDirectory))) {
    return [];
  }

  const files = await listFilesRecursively(pkgDirectory);
  return files
    .filter((filePath) => {
      const lowerPath = filePath.toLowerCase();
      return STORE_PACKAGE_EXTENSIONS.has(path.extname(lowerPath));
    })
    .sort((left, right) => {
      const leftLower = left.toLowerCase();
      const rightLower = right.toLowerCase();
      const leftExtension = path.extname(leftLower);
      const rightExtension = path.extname(rightLower);
      if (leftExtension !== rightExtension) {
        if (leftExtension === '.msix') {
          return -1;
        }
        if (rightExtension === '.msix') {
          return 1;
        }
      }
      return leftLower.localeCompare(rightLower);
    });
}

async function clearStoreOutputs(pkgDirectory) {
  const existingOutputs = await findStoreOutputs(pkgDirectory);
  await Promise.all(existingOutputs.map((filePath) => rm(filePath, { force: true })));
}

export async function buildAppx({
  planPath,
  workspacePath,
  platformId,
  forceDryRun = false,
  desktopBuildCommand,
  signingMode = 'disabled',
  artifactVariant = 'unsigned'
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));
  const storePackageVersion = normalizeStorePackageVersion(plan.upstream.desktop.tag, storePackageConfig.packageVersion);
  const normalizedArtifactVariant = normalizeArtifactVariant(artifactVariant);
  const normalizedSigningMode = normalizedArtifactVariant === 'signed'
    ? normalizeStoreSigningMode(signingMode === 'disabled' ? 'required' : signingMode)
    : 'disabled';
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: normalizedSigningMode
  });

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  const pkgDirectory = path.join(workspaceManifest.desktopWorkspace, 'pkg');
  await ensureDir(pkgDirectory);
  const overlayConfig = await writeStoreElectronBuilderConfig({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    sourceConfigPath: storePackageConfig.desktop.electronBuilderConfigPath,
    outputConfigPath: `electron-builder.store.${normalizedArtifactVariant}.yml`,
    packageVersion: storePackageVersion,
    publisherOverride: signingConfig.enabled ? signingConfig.publisher : null,
    signingConfig
  });
  const verificationScriptPath = path.join(
    repoRoot,
    storePackageConfig.signing.verificationScriptRelativePath
  );

  if (signingConfig.enabled && !(await pathExists(verificationScriptPath))) {
    throw new Error(`Missing Store signature verification script at ${verificationScriptPath}.`);
  }

  const packageLockPath = path.join(workspaceManifest.desktopWorkspace, 'package-lock.json');
  if (!forceDryRun && await pathExists(packageLockPath)) {
    await runCommand(npmCommand(), ['ci'], { cwd: workspaceManifest.desktopWorkspace });
  }

  const desktopBuildStrategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace: workspaceManifest.desktopWorkspace
  });
  const syntheticDryRun = forceDryRun || (await shouldUseSyntheticDryRunBuild({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    planDryRun: plan.build.dryRun
  }));

  await clearStoreOutputs(pkgDirectory);

  if (syntheticDryRun) {
    await createSyntheticStorePackage({
      artifactPath: path.join(pkgDirectory, buildStoreArtifactName(plan.release.tag, platformId, normalizedArtifactVariant, '.msix')),
      runtimeInjectionRoot: workspaceManifest.runtimeInjectionRoot,
      packageIdentity: storePackageConfig.packageIdentity,
      packageVersion: storePackageVersion
    });
  } else if (desktopBuildCommand) {
    await runShellCommand(desktopBuildCommand, workspaceManifest.desktopWorkspace);
  } else {
    const desktopBuildSteps = buildDesktopStoreSteps(overlayConfig.outputPath, desktopBuildStrategy, {
      packerRepoRoot: repoRoot,
      platform: process.platform
    });
    await executeDesktopBuildSteps(desktopBuildSteps, workspaceManifest.desktopWorkspace);
  }

  const storeOutputs = await findStoreOutputs(pkgDirectory);
  if (storeOutputs.length === 0) {
    throw new Error(`No Store package outputs (.appx/.msix) were produced under ${pkgDirectory}.`);
  }

  const primaryOutput = storeOutputs[0];
  const storePackageExtension = path.extname(primaryOutput).toLowerCase();
  if (!STORE_PACKAGE_EXTENSIONS.has(storePackageExtension)) {
    throw new Error(`Unsupported Store package extension ${storePackageExtension || '[none]'} from ${primaryOutput}.`);
  }

  const publishedArtifactFileName = buildStoreArtifactName(
    plan.release.tag,
    platformId,
    normalizedArtifactVariant,
    storePackageExtension
  );
  const publishedArtifactPath = path.join(workspaceManifest.outputDirectory, publishedArtifactFileName);
  await ensureDir(workspaceManifest.outputDirectory);
  await copySingleFile(primaryOutput, publishedArtifactPath);

  const primaryForStoreSubmission = normalizedArtifactVariant === 'unsigned';
  const artifactSigned = normalizedArtifactVariant === 'signed';
  const finalArtifactSigningExpected = signingConfig.enabled && !signingConfig.skipFinalAppxSigning;
  const verificationStatus = normalizedArtifactVariant === 'signed'
    ? (syntheticDryRun
        ? 'synthetic'
        : finalArtifactSigningExpected
          ? 'pending-verification'
          : 'pending-finalization')
    : 'not-applicable';

  const buildMetadata = {
    validationPassed: true,
    platform: platformId,
    artifactVariant: normalizedArtifactVariant,
    primaryForStoreSubmission,
    distributionMode: 'steam',
    runtimeSource: 'portable-fixed',
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    releaseTag: workspaceManifest.releaseTag,
    storePackageVersion,
    storePackageExtension,
    buildMode: syntheticDryRun
      ? 'synthetic-dry-run'
      : desktopBuildCommand
        ? 'custom-desktop-build-command'
        : 'desktop-build-pipeline',
    sourceElectronBuilderConfigPath: overlayConfig.sourcePath,
    outputElectronBuilderConfigPath: overlayConfig.outputPath,
    outputElectronBuilderBuildVersion: overlayConfig.packageVersion,
    rawStoreOutputs: storeOutputs,
    publishedArtifactPath,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      skipFinalAppxSigning: signingConfig.skipFinalAppxSigning,
      finalArtifactSigningExpected,
      status: signingConfig.enabled ? verificationStatus : 'disabled',
      publisher: signingConfig.publisher,
      publisherName: signingConfig.publisherName,
      verificationScriptPath: signingConfig.enabled ? verificationScriptPath : null,
      missingConfiguration: signingConfig.missing
    }
  };
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}-${normalizedArtifactVariant}.json`);
  await writeJson(buildMetadataPath, buildMetadata);

  const artifactRecord = await createArtifactRecord({
    artifactPath: publishedArtifactPath,
    platformId,
    metadata: {
      distributionMode: 'steam',
      runtimeSource: 'portable-fixed',
      desktopVersion: workspaceManifest.desktopVersion,
      desktopTag: workspaceManifest.desktopTag,
      desktopRef: workspaceManifest.desktopRef,
      serverVersion: workspaceManifest.serverVersion,
      storePackageVersion,
      storePackageExtension,
      variant: normalizedArtifactVariant,
      signed: artifactSigned,
      contentSigned: artifactSigned,
      finalArtifactSigned: artifactSigned && finalArtifactSigningExpected,
      primaryForStoreSubmission
    }
  });
  const artifactInventory = {
    platform: platformId,
    artifactVariant: normalizedArtifactVariant,
    releaseTag: workspaceManifest.releaseTag,
    storePackageVersion,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      status: buildMetadata.signing.status
    },
    artifacts: [artifactRecord],
    buildMetadataPath,
    workspaceValidationPath: path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`),
    payloadValidationPath: path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`)
  };
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}-${normalizedArtifactVariant}.json`);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### Store package build prepared for ${platformId} (${normalizedArtifactVariant})`,
    `- Release tag: ${workspaceManifest.releaseTag}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Store package version: ${storePackageVersion}`,
    `- Store package extension: ${storePackageExtension}`,
    '- Distribution mode: steam',
    `- Published artifact: ${publishedArtifactFileName}`,
    `- Primary Store submission artifact: ${primaryForStoreSubmission}`,
    `- Signing mode: ${normalizedSigningMode}`,
    `- Build mode: ${buildMetadata.buildMode}`
  ]);

  return {
    artifactInventoryPath,
    buildMetadataPath,
    artifactPath: publishedArtifactPath,
    artifactVariant: normalizedArtifactVariant
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean' },
      'desktop-build-command': { type: 'string' },
      'signing-mode': { type: 'string' },
      'artifact-variant': { type: 'string' }
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
    desktopBuildCommand: values['desktop-build-command'],
    signingMode: values['signing-mode'] ?? 'disabled',
    artifactVariant: values['artifact-variant'] ?? 'unsigned'
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Store package build failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
