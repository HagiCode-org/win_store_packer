#!/usr/bin/env node
import path from 'node:path';
import { rename, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { runCommand } from './lib/command.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { buildStoreArtifactName } from './lib/platforms.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { buildDesktopStoreSteps, resolveDesktopStoreBuildStrategy } from './lib/desktop-build.mjs';
import {
  loadStorePackageConfig,
  normalizeStoreSigningMode,
  resolveStoreSigningConfig,
} from './lib/store-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

const STORE_PACKAGE_EXTENSIONS = new Set(['.appx', '.msix']);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeArtifactVariant(value) {
  const normalized = String(value ?? 'unsigned').trim().toLowerCase();
  if (!['unsigned', 'signed'].includes(normalized)) {
    throw new Error(`Unsupported artifact variant ${JSON.stringify(value)}. Expected unsigned or signed.`);
  }
  return normalized;
}

function appendSuffixBeforeExtension(fileName, suffix) {
  const extension = path.extname(fileName);
  if (!extension) {
    return `${fileName}${suffix}`;
  }

  return `${fileName.slice(0, -extension.length)}${suffix}${extension}`;
}

async function normalizePublishedArtifacts({ artifacts, outputDirectory, releaseTag, platformId, artifactVariant, primaryArtifactPath }) {
  const usedFileNames = new Set();
  const resolvedPrimaryArtifactPath = path.resolve(primaryArtifactPath);
  let normalizedPrimaryArtifactPath = primaryArtifactPath;
  const normalizedArtifacts = [];

  for (const [index, artifact] of artifacts.entries()) {
    const baseFileName = buildStoreArtifactName(releaseTag, platformId, artifactVariant, artifact.extension);
    let desiredFileName = index === 0 ? baseFileName : appendSuffixBeforeExtension(baseFileName, `-${index + 1}`);
    let duplicateIndex = index + 1;
    while (usedFileNames.has(desiredFileName)) {
      duplicateIndex += 1;
      desiredFileName = appendSuffixBeforeExtension(baseFileName, `-${duplicateIndex}`);
    }

    usedFileNames.add(desiredFileName);

    const currentArtifactPath = path.resolve(artifact.path);
    const desiredArtifactPath = path.join(outputDirectory, desiredFileName);
    if (currentArtifactPath !== path.resolve(desiredArtifactPath)) {
      await rm(desiredArtifactPath, { force: true });
      await rename(currentArtifactPath, desiredArtifactPath);
    }

    if (currentArtifactPath === resolvedPrimaryArtifactPath) {
      normalizedPrimaryArtifactPath = desiredArtifactPath;
    }

    normalizedArtifacts.push({
      ...artifact,
      path: desiredArtifactPath,
      fileName: desiredFileName,
    });
  }

  return {
    artifacts: normalizedArtifacts,
    primaryArtifactPath: normalizedPrimaryArtifactPath,
  };
}

async function executeDesktopBuildSteps(steps, cwd, env = process.env) {
  for (const [index, step] of steps.entries()) {
    const stepLabel = `step ${index + 1}/${steps.length}: ${step.name}`;
    console.log(`[build-appx] ${stepLabel}`);

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      console.log(`[build-appx] still running ${stepLabel} (${elapsedSeconds}s elapsed)`);
    }, 30_000);

    heartbeat.unref?.();

    try {
      await runCommand(step.command, step.args, { cwd, env });
    } finally {
      clearInterval(heartbeat);
    }

    const completedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    console.log(`[build-appx] completed ${stepLabel} (${completedSeconds}s)`);
  }
}

function resolveDesktopMetadataPath(value, desktopWorkspace) {
  const normalized = requireNonEmptyString(value, 'desktopBuildMetadata path');
  return path.isAbsolute(normalized) ? normalized : path.resolve(desktopWorkspace, normalized);
}

function validateDesktopBuildMetadata(metadata, { desktopWorkspace }) {
  const normalized = requireObject(metadata, 'desktopBuildMetadata');
  const artifacts = requireArray(normalized.artifacts, 'desktopBuildMetadata.artifacts').map((artifact, index) => {
    const entry = requireObject(artifact, `desktopBuildMetadata.artifacts[${index}]`);
    const artifactPath = resolveDesktopMetadataPath(entry.path, desktopWorkspace);
    const extension = path.extname(artifactPath).toLowerCase();
    if (!STORE_PACKAGE_EXTENSIONS.has(extension)) {
      throw new Error(`desktopBuildMetadata.artifacts[${index}] must reference an .appx or .msix file. Received ${artifactPath}.`);
    }

    return {
      ...entry,
      path: artifactPath,
      fileName: requireNonEmptyString(entry.fileName, `desktopBuildMetadata.artifacts[${index}].fileName`),
      type: requireNonEmptyString(entry.type, `desktopBuildMetadata.artifacts[${index}].type`),
      extension,
    };
  });

  const primaryArtifactPath = normalized.primaryArtifactPath
    ? resolveDesktopMetadataPath(normalized.primaryArtifactPath, desktopWorkspace)
    : artifacts[0].path;
  const primaryArtifact = artifacts.find((artifact) => artifact.path === primaryArtifactPath) ?? artifacts[0];

  return {
    ...normalized,
    buildMode: requireNonEmptyString(normalized.buildMode, 'desktopBuildMetadata.buildMode'),
    desktopVersion: requireNonEmptyString(normalized.desktopVersion, 'desktopBuildMetadata.desktopVersion'),
    desktopSourceRef: requireNonEmptyString(normalized.desktopSourceRef, 'desktopBuildMetadata.desktopSourceRef'),
    storePackageVersion: requireNonEmptyString(normalized.storePackageVersion, 'desktopBuildMetadata.storePackageVersion'),
    storeConfigPath: requireNonEmptyString(normalized.storeConfigPath, 'desktopBuildMetadata.storeConfigPath'),
    overlayConfigPath: requireNonEmptyString(normalized.overlayConfigPath, 'desktopBuildMetadata.overlayConfigPath'),
    effectiveRuntimeInjectionPath: requireNonEmptyString(
      normalized.effectiveRuntimeInjectionPath,
      'desktopBuildMetadata.effectiveRuntimeInjectionPath'
    ),
    serverPayloadPath: normalized.serverPayloadPath ? String(normalized.serverPayloadPath) : null,
    serverPayloadRoot: normalized.serverPayloadRoot ? String(normalized.serverPayloadRoot) : null,
    primaryArtifactPath,
    primaryArtifact,
    artifacts,
    store: requireObject(normalized.store, 'desktopBuildMetadata.store'),
  };
}

function deriveInitialSigningState({ desktopBuildMetadata, signingConfig, dryRun, artifactVariant }) {
  if (!signingConfig.enabled) {
    return {
      contentSigned: false,
      finalArtifactSigned: false,
      status: 'disabled',
    };
  }

  if (dryRun) {
    return {
      contentSigned: false,
      finalArtifactSigned: false,
      status: 'synthetic',
    };
  }

  if (signingConfig.external) {
    return {
      contentSigned: false,
      finalArtifactSigned: false,
      status: 'pending-external-finalization',
    };
  }

  if (signingConfig.skipFinalAppxSigning) {
    return {
      contentSigned: true,
      finalArtifactSigned: false,
      status: 'pending-finalization',
    };
  }

  const desktopProducedSignedArtifact = artifactVariant === 'signed' && desktopBuildMetadata.buildMode !== 'desktop-store-build-dry-run';
  return {
    contentSigned: desktopProducedSignedArtifact,
    finalArtifactSigned: desktopProducedSignedArtifact,
    status: desktopProducedSignedArtifact ? 'pending-verification' : 'pending-finalization',
  };
}

export async function buildAppx({
  planPath,
  workspacePath,
  platformId,
  forceDryRun = false,
  signingMode = 'disabled',
  artifactVariant = 'unsigned'
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));
  const payloadValidationPath = path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`);
  const payloadValidation = await readJson(payloadValidationPath);
  const normalizedArtifactVariant = normalizeArtifactVariant(artifactVariant);
  const normalizedSigningMode = normalizedArtifactVariant === 'signed'
    ? normalizeStoreSigningMode(signingMode === 'disabled' ? 'required' : signingMode)
    : 'disabled';
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: normalizedSigningMode,
  });
  const verificationScriptPath = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', storePackageConfig.signing.verificationScriptRelativePath)
  );
  const shouldDryRun = forceDryRun || plan.build.dryRun;

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  if (!payloadValidation.validationPassed) {
    throw new Error(`Payload validation report ${payloadValidationPath} is not marked as successful.`);
  }

  if (signingConfig.enabled && !(await pathExists(verificationScriptPath))) {
    throw new Error(`Missing Store signature verification script at ${verificationScriptPath}.`);
  }

  const desktopBuildStrategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    buildCommand: workspaceManifest.desktopBuildCommand ?? storePackageConfig.desktop.buildCommand,
  });
  if (!desktopBuildStrategy.canBuild) {
    throw new Error('Desktop workspace is missing the direct Store build contract required by win_store_packer.');
  }

  const packageLockPath = path.join(workspaceManifest.desktopWorkspace, 'package-lock.json');
  const skipDesktopWorkspaceInstall = process.env.WIN_STORE_PACKER_SKIP_DESKTOP_NPM_CI === '1';
  if (!shouldDryRun && !skipDesktopWorkspaceInstall && await pathExists(packageLockPath)) {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd: workspaceManifest.desktopWorkspace });
  }

  await ensureDir(workspaceManifest.outputDirectory);
  await ensureDir(workspaceManifest.reportsDirectory);

  const desktopBuildMetadataPath = path.join(
    workspaceManifest.reportsDirectory,
    `desktop-store-build-${platformId}-${normalizedArtifactVariant}.json`
  );
  const overlayOutputPath = path.join(
    workspaceManifest.desktopWorkspace,
    `electron-builder.store.${normalizedArtifactVariant}.yml`
  );
  const desktopForwardArgs = [
    '--store-config-path',
    workspaceManifest.desktopStoreConfigPath,
    '--server-payload-path',
    payloadValidation.payloadRootForDesktopBuild ?? payloadValidation.validatedPayloadRoot,
    '--runtime-injection-path',
    workspaceManifest.runtimeInjectionRoot,
    '--artifact-output-dir',
    workspaceManifest.outputDirectory,
    '--metadata-output-path',
    desktopBuildMetadataPath,
    '--overlay-output-path',
    overlayOutputPath,
    '--platform-id',
    platformId,
  ];

  if (shouldDryRun) {
    desktopForwardArgs.push('--dry-run');
  }

  const desktopBuildSteps = buildDesktopStoreSteps(desktopBuildStrategy, {
    platform: process.platform,
    forwardArgs: desktopForwardArgs,
  });

  const desktopBuildEnv = { ...process.env };
  if (signingConfig.enabled && signingConfig.publisher && !desktopBuildEnv.WINDOWS_PACKAGE_PUBLISHER) {
    // Keep the desktop-owned MSIX manifest publisher aligned with the signing certificate subject.
    desktopBuildEnv.WINDOWS_PACKAGE_PUBLISHER = signingConfig.publisher;
  }

  await executeDesktopBuildSteps(desktopBuildSteps, workspaceManifest.desktopWorkspace, desktopBuildEnv);

  const desktopBuildMetadata = validateDesktopBuildMetadata(
    await readJson(desktopBuildMetadataPath),
    { desktopWorkspace: workspaceManifest.desktopWorkspace }
  );

  if (!(await pathExists(desktopBuildMetadata.primaryArtifactPath))) {
    throw new Error(`Desktop build did not produce the expected Store package artifact: ${desktopBuildMetadata.primaryArtifactPath}`);
  }

  const normalizedPublishedArtifacts = await normalizePublishedArtifacts({
    artifacts: desktopBuildMetadata.artifacts,
    outputDirectory: workspaceManifest.outputDirectory,
    releaseTag: workspaceManifest.releaseTag,
    platformId,
    artifactVariant: normalizedArtifactVariant,
    primaryArtifactPath: desktopBuildMetadata.primaryArtifactPath,
  });
  const publishedDesktopBuildMetadata = {
    ...desktopBuildMetadata,
    artifacts: normalizedPublishedArtifacts.artifacts,
    primaryArtifactPath: normalizedPublishedArtifacts.primaryArtifactPath,
    primaryArtifact: normalizedPublishedArtifacts.artifacts.find(
      (artifact) => artifact.path === normalizedPublishedArtifacts.primaryArtifactPath
    ) ?? normalizedPublishedArtifacts.artifacts[0],
  };

  const signingState = deriveInitialSigningState({
    desktopBuildMetadata: publishedDesktopBuildMetadata,
    signingConfig,
    dryRun: shouldDryRun,
    artifactVariant: normalizedArtifactVariant,
  });
  const artifactRecords = await Promise.all(
    publishedDesktopBuildMetadata.artifacts.map(async (artifact) => {
      if (!(await pathExists(artifact.path))) {
        throw new Error(`Desktop build metadata referenced a missing artifact: ${artifact.path}`);
      }

      return createArtifactRecord({
        artifactPath: artifact.path,
        platformId,
        metadata: {
          desktopProduced: true,
          desktopBuildMetadataPath,
          desktopBuildMode: publishedDesktopBuildMetadata.buildMode,
          desktopVersion: workspaceManifest.desktopVersion,
          desktopTag: workspaceManifest.desktopTag,
          desktopRef: workspaceManifest.desktopRef,
          desktopSourceRef: publishedDesktopBuildMetadata.desktopSourceRef,
          serverVersion: workspaceManifest.serverVersion,
          storePackageVersion: publishedDesktopBuildMetadata.storePackageVersion,
          storePackageExtension: artifact.extension,
          storeConfigPath: publishedDesktopBuildMetadata.storeConfigPath,
          overlayConfigPath: publishedDesktopBuildMetadata.overlayConfigPath,
          runtimeInjectionPath: publishedDesktopBuildMetadata.effectiveRuntimeInjectionPath,
          serverPayloadPath: publishedDesktopBuildMetadata.serverPayloadPath,
          serverPayloadRoot: publishedDesktopBuildMetadata.serverPayloadRoot,
          languages: Array.isArray(publishedDesktopBuildMetadata.store.languages)
            ? [...publishedDesktopBuildMetadata.store.languages]
            : [],
          identityName: publishedDesktopBuildMetadata.store.identityName ?? null,
          publisher: publishedDesktopBuildMetadata.store.publisher ?? null,
          variant: normalizedArtifactVariant,
          signed: signingState.finalArtifactSigned,
          contentSigned: signingState.contentSigned,
          finalArtifactSigned: signingState.finalArtifactSigned,
          primaryForStoreSubmission: normalizedArtifactVariant === 'unsigned' && artifact.path === publishedDesktopBuildMetadata.primaryArtifactPath,
        },
      });
    })
  );

  const primaryArtifactRecord = artifactRecords.find(
    (artifact) => artifact.outputPath === publishedDesktopBuildMetadata.primaryArtifactPath
  ) ?? artifactRecords[0];
  const buildMetadata = {
    validationPassed: true,
    platform: platformId,
    artifactVariant: normalizedArtifactVariant,
    desktopBuildMetadataPath,
    desktopBuildMode: publishedDesktopBuildMetadata.buildMode,
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    releaseTag: workspaceManifest.releaseTag,
    storePackageVersion: publishedDesktopBuildMetadata.storePackageVersion,
    storePackageExtension: path.extname(publishedDesktopBuildMetadata.primaryArtifactPath).toLowerCase(),
    storeConfigPath: publishedDesktopBuildMetadata.storeConfigPath,
    overlayConfigPath: publishedDesktopBuildMetadata.overlayConfigPath,
    effectiveRuntimeInjectionPath: publishedDesktopBuildMetadata.effectiveRuntimeInjectionPath,
    serverPayloadPath: publishedDesktopBuildMetadata.serverPayloadPath,
    serverPayloadRoot: publishedDesktopBuildMetadata.serverPayloadRoot,
    desktopProducedArtifactPath: publishedDesktopBuildMetadata.primaryArtifactPath,
    desktopProducedArtifactPaths: artifactRecords.map((artifact) => artifact.outputPath),
    publishedArtifactPath: primaryArtifactRecord.outputPath,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      external: signingConfig.external,
      skipFinalAppxSigning: signingConfig.skipFinalAppxSigning,
      finalArtifactSigningExpected: signingConfig.enabled && !signingConfig.skipFinalAppxSigning,
      status: signingState.status,
      publisher: signingConfig.publisher,
      publisherName: signingConfig.publisherName,
      verificationScriptPath: signingConfig.enabled ? verificationScriptPath : null,
      missingConfiguration: signingConfig.missing,
    },
  };
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}-${normalizedArtifactVariant}.json`);
  await writeJson(buildMetadataPath, buildMetadata);

  const artifactInventory = {
    platform: platformId,
    artifactVariant: normalizedArtifactVariant,
    releaseTag: workspaceManifest.releaseTag,
    storePackageVersion: desktopBuildMetadata.storePackageVersion,
    storeConfigPath: desktopBuildMetadata.storeConfigPath,
    desktopBuildMetadataPath,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      external: signingConfig.external,
      finalized: false,
      status: signingState.status,
    },
    artifacts: artifactRecords,
    buildMetadataPath,
    workspaceValidationPath: path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`),
    payloadValidationPath,
  };
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}-${normalizedArtifactVariant}.json`);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### Store package build prepared for ${platformId} (${normalizedArtifactVariant})`,
    `- Release tag: ${workspaceManifest.releaseTag}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Store config path: ${desktopBuildMetadata.storeConfigPath}`,
    `- Store package version: ${desktopBuildMetadata.storePackageVersion}`,
    `- Published artifact: ${path.basename(primaryArtifactRecord.outputPath)}`,
    `- Signing mode: ${normalizedSigningMode}`,
    `- Build mode: ${desktopBuildMetadata.buildMode}`,
  ]);

  return {
    artifactInventoryPath,
    buildMetadataPath,
    artifactPath: primaryArtifactRecord.outputPath,
    artifactVariant: normalizedArtifactVariant,
    desktopBuildMetadataPath,
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean' },
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
