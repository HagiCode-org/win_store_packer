import path from 'node:path';
import { pathExists, readJson } from './fs-utils.mjs';

const DEFAULT_STORE_BUILD_COMMAND = 'build:win:store';

// Tagged desktop workspaces predate and follow the desktop's move to pnpm, so the package manager
// follows the lockfile the workspace actually carries.
function packageManagerCommand(packageManager = 'npm', platform = process.platform) {
  return platform === 'win32' ? `${packageManager}.cmd` : packageManager;
}

function normalizeShellPath(value) {
  return String(value).replaceAll('\\', '/');
}

function shellQuote(value) {
  return JSON.stringify(normalizeShellPath(value));
}

function createStep(name, command, args) {
  return { name, command, args };
}

export async function resolveDesktopStoreBuildStrategy({ desktopWorkspace, buildCommand = DEFAULT_STORE_BUILD_COMMAND }) {
  const packageJsonPath = path.join(desktopWorkspace, 'package.json');
  const storeConfigPath = path.join(desktopWorkspace, 'config', 'store-package.json');

  if (!(await pathExists(packageJsonPath))) {
    return {
      packageJsonPath,
      packageJsonPresent: false,
      storeConfigPath,
      storeConfigPresent: false,
      hasStoreBuildCommand: false,
      canBuild: false,
      isCompatible: false,
      buildCommand,
      scripts: {},
    };
  }

  const packageJson = await readJson(packageJsonPath);
  const packageManager = (await pathExists(path.join(desktopWorkspace, 'pnpm-lock.yaml'))) ? 'pnpm' : 'npm';
  const scripts = packageJson?.scripts ?? {};
  const hasStoreBuildCommand = typeof scripts[buildCommand] === 'string';
  const storeConfigPresent = await pathExists(storeConfigPath);
  const canBuild = hasStoreBuildCommand && storeConfigPresent;

  return {
    packageJsonPath,
    packageJsonPresent: true,
    storeConfigPath,
    storeConfigPresent,
    hasStoreBuildCommand,
    canBuild,
    isCompatible: canBuild,
    buildCommand,
    packageManager,
    scripts,
  };
}

export function buildDesktopStoreSteps(strategy, options = {}) {
  if (!strategy.canBuild) {
    throw new Error('Desktop workspace is missing the direct Store build contract required by win_store_packer.');
  }

  const platform = options.platform ?? process.platform;
  const forwardedArgs = Array.isArray(options.forwardArgs) ? options.forwardArgs.filter(Boolean) : [];
  const packageManager = strategy.packageManager ?? 'npm';
  const args = ['run', strategy.buildCommand];
  if (forwardedArgs.length > 0) {
    // npm needs `--` to forward flags to the script; pnpm forwards them as they are and would pass `--` on.
    if (packageManager === 'npm') args.push('--');
    args.push(...forwardedArgs);
  }

  return [createStep(`${packageManager} run ${strategy.buildCommand}`, packageManagerCommand(packageManager, platform), args)];
}

export function buildDesktopStoreCommand(strategy, options = {}) {
  const [step] = buildDesktopStoreSteps(strategy, options);
  return [step.command, ...step.args.map((arg) => shellQuote(arg))].join(' ');
}

export async function shouldUseSyntheticDryRunBuild({ desktopWorkspace, planDryRun, buildCommand = DEFAULT_STORE_BUILD_COMMAND }) {
  if (!planDryRun) {
    return false;
  }

  const strategy = await resolveDesktopStoreBuildStrategy({ desktopWorkspace, buildCommand });
  return !strategy.isCompatible;
}
