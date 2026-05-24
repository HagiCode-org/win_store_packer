#!/usr/bin/env node
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanDir, ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { runCommand, runCommandResult } from './lib/command.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { loadStorePackageConfig, loadWorkflowDefaults } from './lib/store-config.mjs';
import { resolveDesktopStoreBuildStrategy } from './lib/desktop-build.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

async function ensureGitTagExists(sourcePath, desktopTag) {
  const result = await runCommandResult(
    'git',
    ['-C', sourcePath, 'rev-parse', '--verify', '--quiet', `refs/tags/${desktopTag}`]
  );
  if (result.code !== 0) {
    throw new Error(`Desktop tag ${desktopTag} is not available in ${sourcePath}. Ensure the tracked desktop source includes the selected release tag.`);
  }
}

async function resolveGitRevision(sourcePath, ref) {
  const result = await runCommandResult('git', ['-C', sourcePath, 'rev-parse', ref]);
  if (result.code !== 0) {
    throw new Error(`Unable to resolve git ref ${ref} in ${sourcePath}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function validateDesktopWorkspace({ desktopWorkspace, storePackageConfig }) {
  const packageJsonPath = path.join(desktopWorkspace, 'package.json');
  const electronBuilderPath = path.join(desktopWorkspace, storePackageConfig.desktop.electronBuilderConfigPath);
  const runtimeRoot = path.join(desktopWorkspace, storePackageConfig.desktop.runtimeInjectionPath);

  if (!(await pathExists(packageJsonPath))) {
    throw new Error(`Desktop workspace is missing package.json at ${packageJsonPath}.`);
  }
  if (!(await pathExists(electronBuilderPath))) {
    throw new Error(`Desktop workspace is missing ${storePackageConfig.desktop.electronBuilderConfigPath}.`);
  }

  const buildStrategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace
  });
  if (!buildStrategy.isCompatible) {
    throw new Error(
      'Desktop workspace is missing the current Store packaging pipeline required for AppX packaging.'
    );
  }

  await ensureDir(runtimeRoot);

  return {
    packageJsonPath,
    electronBuilderPath,
    runtimeRoot,
    buildStrategy
  };
}

export async function preparePackagingWorkspace({
  planPath,
  platformId,
  workspacePath,
  desktopSourcePath
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const workflowDefaults = await loadWorkflowDefaults();

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  const resolvedDesktopSourcePath = path.resolve(desktopSourcePath ?? workflowDefaults.desktopSourcePath);
  if (!(await pathExists(resolvedDesktopSourcePath))) {
    throw new Error(`Desktop source path ${resolvedDesktopSourcePath} does not exist. Initialize the hagicode-desktop submodule or override --desktop-source.`);
  }

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const downloadDirectory = path.join(resolvedWorkspacePath, 'downloads');
  const extractDirectory = path.join(resolvedWorkspacePath, 'extracted');
  const outputDirectory = path.join(resolvedWorkspacePath, 'release-assets');
  const reportsDirectory = path.join(resolvedWorkspacePath, 'reports');
  const desktopWorkspace = path.join(extractDirectory, 'desktop');

  await cleanDir(resolvedWorkspacePath);
  await ensureDir(downloadDirectory);
  await ensureDir(extractDirectory);
  await ensureDir(outputDirectory);
  await ensureDir(reportsDirectory);

  await runCommand('git', ['-C', resolvedDesktopSourcePath, 'worktree', 'prune']);
  await ensureGitTagExists(resolvedDesktopSourcePath, plan.upstream.desktop.tag);
  await runCommand('git', ['-C', resolvedDesktopSourcePath, 'worktree', 'add', '--detach', desktopWorkspace, `refs/tags/${plan.upstream.desktop.tag}`]);

  const validation = await validateDesktopWorkspace({ desktopWorkspace, storePackageConfig });
  const desktopRef = await resolveGitRevision(desktopWorkspace, 'HEAD');
  const tagObject = await resolveGitRevision(resolvedDesktopSourcePath, `refs/tags/${plan.upstream.desktop.tag}`);

  const workspaceManifest = {
    planPath: path.resolve(planPath),
    platform: platformId,
    workspacePath: resolvedWorkspacePath,
    desktopSourcePath: resolvedDesktopSourcePath,
    desktopWorkspace,
    downloadDirectory,
    extractDirectory,
    outputDirectory,
    reportsDirectory,
    packageJsonPath: validation.packageJsonPath,
    electronBuilderConfigPath: validation.electronBuilderPath,
    runtimeInjectionRoot: validation.runtimeRoot,
    desktopVersion: plan.upstream.desktop.version,
    desktopTag: plan.upstream.desktop.tag,
    desktopTagObject: tagObject,
    desktopRef,
    desktopAssetName: plan.upstream.desktop.assetsByPlatform[platformId]?.name ?? null,
    desktopAssetPath: plan.upstream.desktop.assetsByPlatform[platformId]?.path ?? null,
    serverVersion: plan.upstream.server.version,
    releaseTag: plan.release.tag,
    dryRun: plan.build.dryRun
  };
  const workspaceManifestPath = path.join(resolvedWorkspacePath, 'workspace-manifest.json');
  await writeJson(workspaceManifestPath, workspaceManifest);

  const workspaceReport = {
    validationPassed: true,
    platform: platformId,
    desktopVersion: plan.upstream.desktop.version,
    desktopTag: plan.upstream.desktop.tag,
    desktopRef,
    desktopTagObject: tagObject,
    serverVersion: plan.upstream.server.version,
    targetPaths: {
      desktopWorkspace,
      runtimeInjectionRoot: validation.runtimeRoot,
      electronBuilderConfigPath: validation.electronBuilderPath
    },
    checks: {
      tagResolved: true,
      packageJsonPresent: true,
      electronBuilderPresent: true,
      desktopBuildPipelineSupported: validation.buildStrategy.canBuild
    },
    buildStrategy: {
      supported: validation.buildStrategy.canBuild,
      hasElectronBuilderRunner: validation.buildStrategy.hasElectronBuilderRunner
    }
  };
  const workspaceReportPath = path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`);
  await writeJson(workspaceReportPath, workspaceReport);

  await writeGithubOutputs({
    workspace_manifest_path: workspaceManifestPath,
    workspace_report_path: workspaceReportPath,
    desktop_ref: desktopRef
  });

  await appendSummary([
    `### Desktop workspace prepared for ${platformId}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Desktop ref: ${desktopRef}`,
    `- Desktop source: ${resolvedDesktopSourcePath}`,
    `- Desktop workspace: ${desktopWorkspace}`,
    `- Runtime injection root: ${validation.runtimeRoot}`
  ]);

  return {
    workspaceManifestPath,
    workspaceReportPath,
    workspaceManifest
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'desktop-source': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('prepare-packaging-workspace requires --plan, --platform, and --workspace.');
  }

  const result = await preparePackagingWorkspace({
    planPath: values.plan,
    platformId: values.platform,
    workspacePath: values.workspace,
    desktopSourcePath: values['desktop-source']
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Desktop workspace preparation failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
