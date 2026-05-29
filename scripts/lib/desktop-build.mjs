import path from 'node:path';
import { pathExists, readJson } from './fs-utils.mjs';

const DEFAULT_STORE_BUILD_COMMAND = 'build:win:store';

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
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
    scripts,
  };
}

export function buildDesktopStoreSteps(strategy, options = {}) {
  if (!strategy.canBuild) {
    throw new Error('Desktop workspace is missing the direct Store build contract required by win_store_packer.');
  }

  const platform = options.platform ?? process.platform;
  const forwardedArgs = Array.isArray(options.forwardArgs) ? options.forwardArgs.filter(Boolean) : [];
  const args = ['run', strategy.buildCommand];
  if (forwardedArgs.length > 0) {
    args.push('--', ...forwardedArgs);
  }

  return [createStep(`npm run ${strategy.buildCommand}`, npmCommand(platform), args)];
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
