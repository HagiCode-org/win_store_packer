#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import {
  DEFAULT_DLC_PUBLIC_BASE_URL,
  DEFAULT_SERVER_PUBLIC_BASE_URL
} from './lib/artifact-download.mjs';
import {
  PUBLICATION_MODES,
  WORKFLOW_ARTIFACT_HANDOFF_SOURCE
} from './lib/build-plan.mjs';
import { pathExists, readJson } from './lib/fs-utils.mjs';
import { runCommand } from './lib/command.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { loadDesktopStoreConfig, loadWorkflowDefaults } from './lib/store-config.mjs';
import { resolveDispatchBuildPlan } from './resolve-dispatch-build-plan.mjs';
import { preparePackagingWorkspace } from './prepare-packaging-workspace.mjs';
import { stageServerPayload } from './stage-server-payload.mjs';
import { buildMsix } from './build-msix.mjs';
import { REQUIRED_SERVER_PAYLOAD_PATHS } from './lib/payload.mjs';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const DEFAULT_PLAN_PATH = path.join(projectRoot, 'build', 'release-plan.json');
const DEFAULT_PLATFORM = 'win-x64';
const DEFAULT_WORKSPACE_PATH = path.join(projectRoot, 'build', `store-${DEFAULT_PLATFORM}`);
const DEFAULT_LOCAL_PACKER_RELEASE_TAG = 'v0.1.0';
const WINDOWS_PACKAGE_IDENTITY_ENV = 'WINDOWS_PACKAGE_IDENTITY';

const OPTION_DEFINITIONS = {
  plan: { type: 'string' },
  'packer-release-tag': { type: 'string' },
  'desktop-source': { type: 'string' },
  platform: { type: 'string' },
  workspace: { type: 'string' },
  'server-asset-source': { type: 'string' },
  'dlc-asset-source': { type: 'string' },
  'public-base-url': { type: 'string' },
  'dlc-public-base-url': { type: 'string' },
  'purchase-smoke-test': { type: 'boolean' },
  'force-renderer-accessibility': { type: 'boolean' },
  'skip-build': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
};

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function resolvePath(value, fallback) {
  return path.resolve(value ?? fallback);
}

export function parseArgs(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: argv,
      options: OPTION_DEFINITIONS,
      allowPositionals: false,
      strict: true
    }));
  } catch (error) {
    throw new Error(`Invalid local Win Store option: ${error.message}`, { cause: error });
  }

  const firstValue = (optionName, ...environmentNames) => (
    values[optionName] ??
    environmentNames.map((name) => env[name]).find((value) => value !== undefined && value !== '')
  );
  const platform = requireNonEmptyString(firstValue('platform', 'WIN_STORE_PACKER_PLATFORM') ?? DEFAULT_PLATFORM, 'platform');
  const workspace = resolvePath(
    firstValue('workspace', 'WIN_STORE_PACKER_WORKSPACE'),
    path.join(projectRoot, 'build', `store-${platform}`)
  );

  return {
    help: values.help === true,
    plan: resolvePath(firstValue('plan', 'WIN_STORE_PACKER_PLAN_PATH'), DEFAULT_PLAN_PATH),
    planExplicit: values.plan !== undefined || Boolean(env.WIN_STORE_PACKER_PLAN_PATH),
    packerReleaseTag: firstValue(
      'packer-release-tag',
      'WIN_STORE_PACKER_RELEASE_TAG',
      'PACKER_RELEASE_TAG'
    ) ?? DEFAULT_LOCAL_PACKER_RELEASE_TAG,
    desktopSource: resolvePath(
      firstValue('desktop-source', 'WIN_STORE_PACKER_DESKTOP_SOURCE'),
      path.join(projectRoot, 'inputs', 'hagicode-desktop')
    ),
    platform,
    workspace,
    serverAssetSource: firstValue(
      'server-asset-source',
      'WIN_STORE_PACKER_SERVER_ASSET_SOURCE'
    ),
    dlcAssetSource: firstValue(
      'dlc-asset-source',
      'WIN_STORE_PACKER_DLC_ASSET_SOURCE'
    ),
    serverPublicBaseUrl: firstValue(
      'public-base-url',
      'WIN_STORE_PACKER_SERVER_PUBLIC_BASE_URL',
      'SERVER_PUBLIC_BASE_URL',
      'WIN_STORE_PACKER_PUBLIC_BASE_URL',
      'R2_PUBLIC_BASE_URL'
    ) ?? DEFAULT_SERVER_PUBLIC_BASE_URL,
    dlcPublicBaseUrl: firstValue(
      'dlc-public-base-url',
      'WIN_STORE_PACKER_DLC_PUBLIC_BASE_URL',
      'DLC_PUBLIC_BASE_URL',
      'WIN_STORE_PACKER_PUBLIC_BASE_URL',
      'R2_PUBLIC_BASE_URL'
    ) ?? DEFAULT_DLC_PUBLIC_BASE_URL,
    purchaseSmokeTest: values['purchase-smoke-test'] === true,
    forceRendererAccessibility: values['force-renderer-accessibility'] === true,
    skipBuild: values['skip-build'] === true
  };
}

export function validateWindowsHost(platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error('The local Windows Store launcher requires Windows.');
  }
}

export function buildLaunchArguments(options) {
  return [
    ...(options.purchaseSmokeTest ? ['--desktop-subscription-purchase-smoke-test=1'] : []),
    ...(options.forceRendererAccessibility ? ['--force-renderer-accessibility'] : [])
  ];
}

export function resolveArtifactInventoryPath(workspacePath, platformId, artifactVariant = 'unsigned') {
  return path.join(
    path.resolve(workspacePath),
    `artifact-inventory-${platformId}-${artifactVariant}.json`
  );
}

export function resolveBuildMetadataPath(workspacePath, platformId, artifactVariant = 'unsigned') {
  return path.join(
    path.resolve(workspacePath),
    `build-metadata-${platformId}-${artifactVariant}.json`
  );
}

function resolveMetadataArtifactPath(value, workspacePath) {
  const normalized = requireNonEmptyString(value, 'MSIX artifact path');
  return path.isAbsolute(normalized) ? normalized : path.resolve(workspacePath, normalized);
}

export function resolvePrimaryMsixPath({ workspacePath, artifactInventory, buildMetadata }) {
  const inventoryArtifacts = Array.isArray(artifactInventory?.artifacts)
    ? artifactInventory.artifacts
    : [];
  const primaryInventoryArtifact =
    inventoryArtifacts.find((artifact) => artifact.primaryForStoreSubmission) ??
    inventoryArtifacts[0];
  const candidate =
    artifactInventory?.publishedArtifactPath ??
    artifactInventory?.primaryArtifactPath ??
    primaryInventoryArtifact?.outputPath ??
    primaryInventoryArtifact?.sourcePath ??
    primaryInventoryArtifact?.path ??
    buildMetadata?.publishedArtifactPath ??
    buildMetadata?.primaryArtifactPath ??
    buildMetadata?.desktopProducedArtifactPath ??
    buildMetadata?.primaryArtifact?.outputPath ??
    buildMetadata?.primaryArtifact?.path;

  if (!candidate) {
    throw new Error(
      `No primary MSIX artifact is recorded in ${resolveArtifactInventoryPath(workspacePath, artifactInventory?.platform ?? '[platform]')} or build metadata.`
    );
  }

  const artifactPath = resolveMetadataArtifactPath(candidate, workspacePath);
  if (path.extname(artifactPath).toLowerCase() !== '.msix') {
    throw new Error(`The local Store artifact must be an .msix file: ${artifactPath}`);
  }
  return artifactPath;
}

function escapePowerShellLiteral(value) {
  return String(value).replaceAll("'", "''");
}

export function buildRemovePackageCommand(identityName) {
  const escapedIdentity = escapePowerShellLiteral(requireNonEmptyString(identityName, 'package identity'));
  return [
    `$package = Get-AppxPackage -Name '${escapedIdentity}' -ErrorAction SilentlyContinue`,
    'if ($null -ne $package) {',
    '  $package | Remove-AppxPackage -ErrorAction Stop',
    '}'
  ].join('\n');
}

export function buildInstallPackageCommand(msixPath) {
  const escapedPath = escapePowerShellLiteral(requireNonEmptyString(msixPath, 'MSIX path'));
  return `Add-AppxPackage -Path '${escapedPath}' -ErrorAction Stop`;
}

export function buildMsixContentRequirements({
  runtimeInjectionPath,
  desktopWorkspace,
  requiredPaths = REQUIRED_SERVER_PAYLOAD_PATHS,
  includedDlcs = []
}) {
  const runtimeRelativePath = path.relative(
    requireNonEmptyString(desktopWorkspace, 'Desktop workspace'),
    requireNonEmptyString(runtimeInjectionPath, 'runtime injection path')
  );
  if (!runtimeRelativePath || runtimeRelativePath.startsWith('..') || path.isAbsolute(runtimeRelativePath)) {
    throw new Error(
      `Runtime injection path ${runtimeInjectionPath} must be inside the Desktop workspace ${desktopWorkspace}.`
    );
  }

  const normalizedRuntimePath = runtimeRelativePath.split(path.sep).join('/');
  const requirements = new Set(
    requiredPaths.map((entry) => `${normalizedRuntimePath}/${String(entry).replaceAll('\\', '/')}`)
  );
  for (const dlc of includedDlcs) {
    const runtimeTargetPath = String(dlc.runtimeTargetPath ?? '').trim().replaceAll('\\', '/');
    const runtimeIndexPath = String(dlc.runtimeIndexPath ?? '').trim().replaceAll('\\', '/');
    if (runtimeTargetPath) {
      const manifestFileName = String(
        dlc.manifestFileName ?? path.posix.basename(String(dlc.manifestPath ?? ''))
      ).trim();
      const filesManifestFileName = String(
        dlc.filesManifestFileName ?? path.posix.basename(String(dlc.filesManifestPath ?? ''))
      ).trim();
      if (manifestFileName) {
        requirements.add(`${normalizedRuntimePath}/${runtimeTargetPath}/${manifestFileName}`);
      }
      if (filesManifestFileName) {
        requirements.add(`${normalizedRuntimePath}/${runtimeTargetPath}/${filesManifestFileName}`);
      }
    }
    if (runtimeIndexPath) {
      requirements.add(`${normalizedRuntimePath}/${runtimeIndexPath}`);
    }
  }

  return [...requirements];
}

export function buildMsixContentValidationCommand(msixPath, requiredEntries) {
  const escapedPath = escapePowerShellLiteral(requireNonEmptyString(msixPath, 'MSIX path'));
  const entries = requiredEntries
    .map((entry) => `'${escapePowerShellLiteral(requireNonEmptyString(entry, 'MSIX entry'))}'`)
    .join(', ');
  return [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$archive = [System.IO.Compression.ZipFile]::OpenRead('${escapedPath}')`,
    'try {',
    '  $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)',
    '  foreach ($entry in $archive.Entries) { [void]$names.Add($entry.FullName.TrimEnd(\'/\')) }',
    `  $required = @(${entries})`,
    '  $missing = @($required | Where-Object { -not $names.Contains($_.TrimEnd(\'/\')) })',
    '  if ($missing.Count -gt 0) { throw "MSIX is missing packaged runtime entries: $($missing -join \", ")" }',
    '} finally {',
    '  $archive.Dispose()',
    '}'
  ].join('\n');
}

export function buildInstalledAppLaunchCommand(identityName, launchArguments = []) {
  const escapedIdentity = escapePowerShellLiteral(requireNonEmptyString(identityName, 'package identity'));
  const argumentsLiteral = [
    "'shell:AppsFolder\\$($package.PackageFamilyName)!$($application.Id)'",
    ...launchArguments.map((argument) => `'${escapePowerShellLiteral(requireNonEmptyString(argument, 'launch argument'))}'`)
  ].join(', ');
  return [
    `$package = Get-AppxPackage -Name '${escapedIdentity}' -ErrorAction Stop | Select-Object -First 1`,
    'if ($null -eq $package) { throw "Installed package was not found after Add-AppxPackage." }',
    '$manifest = Get-AppxPackageManifest -Package $package',
    '$application = @($manifest.Package.Applications.Application) | Select-Object -First 1',
    'if ($null -eq $application -or [string]::IsNullOrWhiteSpace($application.Id)) { throw "Installed MSIX manifest does not contain an application ID." }',
    `$arguments = @(${argumentsLiteral})`,
    'Start-Process -FilePath \'explorer.exe\' -ArgumentList $arguments'
  ].join('\n');
}

async function runPowerShellCommand(command, runCommandImpl = runCommand) {
  return runCommandImpl('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ]);
}

async function loadWorkspaceMetadata(workspacePath, platformId, artifactVariant) {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifestPath = path.join(resolvedWorkspacePath, 'workspace-manifest.json');
  if (!(await pathExists(workspaceManifestPath))) {
    throw new Error(
      `Packer workspace is missing ${workspaceManifestPath}. Run without --skip-build to prepare it.`
    );
  }

  const workspaceManifest = await readJson(workspaceManifestPath);
  const artifactInventoryPath = resolveArtifactInventoryPath(
    resolvedWorkspacePath,
    platformId,
    artifactVariant
  );
  const buildMetadataPath = resolveBuildMetadataPath(resolvedWorkspacePath, platformId, artifactVariant);
  const artifactInventory = await pathExists(artifactInventoryPath)
    ? await readJson(artifactInventoryPath)
    : null;
  const buildMetadata = await pathExists(buildMetadataPath)
    ? await readJson(buildMetadataPath)
    : null;

  if (!artifactInventory && !buildMetadata) {
    throw new Error(
      `Packer workspace is missing both ${artifactInventoryPath} and ${buildMetadataPath}.`
    );
  }

  return {
    resolvedWorkspacePath,
    workspaceManifest,
    artifactInventory,
    buildMetadata,
    artifactInventoryPath,
    buildMetadataPath
  };
}

async function validateMsixContents({
  msixPath,
  workspacePath,
  workspaceManifest,
  buildMetadata,
  artifactInventory,
  runCommandImpl
}) {
  const payloadValidationPath = path.join(
    path.resolve(workspacePath),
    `payload-validation-${workspaceManifest.platform}.json`
  );
  if (!(await pathExists(payloadValidationPath))) {
    throw new Error(`Missing staged Server payload validation report: ${payloadValidationPath}`);
  }

  const payloadValidation = await readJson(payloadValidationPath);
  if (!payloadValidation.validationPassed) {
    throw new Error(`Staged Server payload validation did not pass: ${payloadValidationPath}`);
  }

  const includedDlcs =
    artifactInventory?.includedDlcs ??
    buildMetadata?.includedDlcs ??
    payloadValidation.includedDlcs ??
    [];
  if (!Array.isArray(includedDlcs) || includedDlcs.length === 0) {
    throw new Error(`Staged payload report ${resolvedPayloadValidationPath} does not list bundled DLC content.`);
  }

  const runtimeInjectionPath =
    buildMetadata?.effectiveRuntimeInjectionPath ??
    workspaceManifest.runtimeInjectionRoot;
  const requiredEntries = buildMsixContentRequirements({
    runtimeInjectionPath,
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    requiredPaths: payloadValidation.requiredPaths ?? REQUIRED_SERVER_PAYLOAD_PATHS,
    includedDlcs
  });
  await runPowerShellCommand(
    buildMsixContentValidationCommand(msixPath, requiredEntries),
    runCommandImpl
  );
  return { payloadValidationPath, requiredEntries };
}

async function resolvePackageIdentity({ workspaceManifest, buildMetadata, artifactInventory }) {
  const metadataIdentity =
    buildMetadata?.store?.identityName ??
    artifactInventory?.artifacts?.find((artifact) => artifact.identityName)?.identityName;
  if (metadataIdentity) {
    return requireNonEmptyString(metadataIdentity, WINDOWS_PACKAGE_IDENTITY_ENV);
  }

  const desktopConfigPath = workspaceManifest.desktopStoreConfigPath ??
    path.join(workspaceManifest.desktopWorkspace, workspaceManifest.desktopStoreConfigRelativePath);
  const { config } = await loadDesktopStoreConfig(
    workspaceManifest.desktopWorkspace,
    path.relative(workspaceManifest.desktopWorkspace, desktopConfigPath)
  );
  return config.packageIdentity.identityName;
}

async function preparePlan(options) {
  if (options.planExplicit) {
    if (!(await pathExists(options.plan))) {
      throw new Error(`Release plan does not exist: ${options.plan}`);
    }
    try {
      await loadReleasePlan(options.plan, {
        expectedReleaseTag: options.packerReleaseTag
      });
    } catch (error) {
      throw new Error(`Release plan validation failed for ${options.plan}: ${error.message}`, { cause: error });
    }
    return options.plan;
  }

  console.log(
    `[local-win-store-test] Generating local release plan for ${options.packerReleaseTag}; resolving the latest indexed Server release...`
  );
  await resolveDispatchBuildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: { platforms: options.platform } },
    outputPath: options.plan,
    packerReleaseTag: options.packerReleaseTag,
    serverPublicBaseUrl: options.serverPublicBaseUrl,
    dlcPublicBaseUrl: options.dlcPublicBaseUrl,
    publicationMode: PUBLICATION_MODES.WORKFLOW_ARTIFACT,
    handoffSource: WORKFLOW_ARTIFACT_HANDOFF_SOURCE,
    producerWorkflow: 'package-release'
  });

  try {
    await loadReleasePlan(options.plan, {
      expectedReleaseTag: options.packerReleaseTag
    });
  } catch (error) {
    throw new Error(`Generated release plan validation failed for ${options.plan}: ${error.message}`, { cause: error });
  }
  return options.plan;
}

async function runBuildStages(options, planPath) {
  console.log(`[local-win-store-test] Preparing Desktop workspace: ${options.workspace}`);
  try {
    await preparePackagingWorkspace({
      planPath,
      platformId: options.platform,
      workspacePath: options.workspace,
      desktopSourcePath: options.desktopSource
    });
  } catch (error) {
    throw new Error(`Desktop workspace preparation failed: ${error.message}`, { cause: error });
  }

  console.log('[local-win-store-test] Staging Server and Turbo Engine payload...');
  try {
    await stageServerPayload({
      planPath,
      workspacePath: options.workspace,
      platformId: options.platform,
      serverAssetSource: options.serverAssetSource,
      serverPublicBaseUrl: options.serverPublicBaseUrl,
      dlcAssetSource: options.dlcAssetSource,
      dlcPublicBaseUrl: options.dlcPublicBaseUrl
    });
  } catch (error) {
    throw new Error(`Server and DLC payload staging failed: ${error.message}`, { cause: error });
  }

  console.log('[local-win-store-test] Building unsigned MSIX...');
  try {
    await buildMsix({
      planPath,
      workspacePath: options.workspace,
      platformId: options.platform,
      artifactVariant: 'unsigned',
      signingMode: 'disabled'
    });
  } catch (error) {
    throw new Error(`MSIX generation failed: ${error.message}`, { cause: error });
  }
}

export async function runLocalWinStoreTest({
  options,
  platform = process.platform,
  runCommandImpl = runCommand
}) {
  validateWindowsHost(platform);
  const planPath = options.skipBuild ? null : await preparePlan(options);
  if (!options.skipBuild) {
    await runBuildStages(options, planPath);
  } else {
    console.log('[local-win-store-test] Skipping plan and packaging stages.');
  }

  const metadata = await loadWorkspaceMetadata(options.workspace, options.platform, 'unsigned');
  const msixPath = resolvePrimaryMsixPath(metadata);
  if (!(await pathExists(msixPath))) {
    throw new Error(`Generated MSIX artifact does not exist: ${msixPath}`);
  }

  await validateMsixContents({
    msixPath,
    workspacePath: metadata.resolvedWorkspacePath,
    workspaceManifest: metadata.workspaceManifest,
    buildMetadata: metadata.buildMetadata,
    artifactInventory: metadata.artifactInventory,
    runCommandImpl
  });

  const identityName = await resolvePackageIdentity({
    workspaceManifest: metadata.workspaceManifest,
    buildMetadata: metadata.buildMetadata,
    artifactInventory: metadata.artifactInventory
  });
  console.log(`[local-win-store-test] Removing any existing package: ${identityName}`);
  await runPowerShellCommand(buildRemovePackageCommand(identityName), runCommandImpl);

  console.log(`[local-win-store-test] Installing MSIX: ${msixPath}`);
  try {
    await runPowerShellCommand(buildInstallPackageCommand(msixPath), runCommandImpl);
  } catch (error) {
    throw new Error(
      `MSIX installation failed for ${msixPath}. Check the package certificate and Windows trust prerequisites. ${error.message}`,
      { cause: error }
    );
  }

  const launchArguments = buildLaunchArguments(options);
  console.log('[local-win-store-test] Launching installed MSIX application...', { launchArguments });
  await runPowerShellCommand(
    buildInstalledAppLaunchCommand(identityName, launchArguments),
    runCommandImpl
  );

  return {
    planPath,
    workspacePath: metadata.resolvedWorkspacePath,
    msixPath,
    identityName,
    launchArguments
  };
}

export function printUsage() {
  console.log(`Usage: npm run test:win-store:local -- [options]

Options:
  --plan <path>                    Release plan (default: build/release-plan.json)
  --packer-release-tag <tag>       Tag used when generating the default plan
  --desktop-source <path>          Desktop source checkout
  --platform <name>                Windows target (default: win-x64)
  --workspace <path>               Packer workspace (default: build/store-<platform>)
  --server-asset-source <path>     Local Server archive override
  --dlc-asset-source <path>        Local Turbo Engine DLC archive override
  --public-base-url <url>          Server public artifact base URL
  --dlc-public-base-url <url>      Turbo Engine DLC public artifact base URL
  --skip-build                     Reuse an existing Packer workspace and MSIX
  --purchase-smoke-test            Forward subscription purchase smoke-test flag
  --force-renderer-accessibility   Forward renderer accessibility flag
  --help, -h                       Show this help
`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  if (options.help) {
    printUsage();
    return;
  }

  validateWindowsHost();
  const workflowDefaults = await loadWorkflowDefaults();
  if (options.desktopSource === path.join(projectRoot, 'inputs', 'hagicode-desktop') &&
      workflowDefaults.desktopSourcePath) {
    options.desktopSource = path.resolve(projectRoot, workflowDefaults.desktopSourcePath);
  }
  if (options.platform === DEFAULT_PLATFORM && workflowDefaults.defaultPlatforms?.[0]) {
    options.platform = workflowDefaults.defaultPlatforms[0];
    if (options.workspace === DEFAULT_WORKSPACE_PATH) {
      options.workspace = path.join(projectRoot, 'build', `store-${options.platform}`);
    }
  }

  return runLocalWinStoreTest({ options });
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(`[local-win-store-test] ${error.message}`);
    process.exitCode = 1;
  });
}
