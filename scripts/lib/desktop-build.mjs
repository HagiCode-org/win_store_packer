import path from 'node:path';
import { pathExists, readJson } from './fs-utils.mjs';

export function selectAvailableScript(scripts, candidates) {
  return candidates.find((scriptName) => typeof scripts?.[scriptName] === 'string') ?? null;
}

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function nodeCommand(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

export async function resolveDesktopStoreBuildStrategy({ desktopWorkspace }) {
  const packageJsonPath = path.join(desktopWorkspace, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    return {
      packageJsonPath,
      packageJsonPresent: false,
      hasElectronBuilderRunner: false,
      canBuild: false,
      isCompatible: false,
      scripts: {}
    };
  }

  const packageJson = await readJson(packageJsonPath);
  const scripts = packageJson?.scripts ?? {};
  const fallbackScripts = {
    runtimeScript: selectAvailableScript(scripts, ['prepare:runtime', 'prepare:runtime:optional']),
    toolchainScript: selectAvailableScript(scripts, ['prepare:bundled-toolchain', 'prepare:bundled-toolchain:optional']),
    codeServerScript: selectAvailableScript(scripts, ['prepare:code-server-runtime', 'prepare:code-server-runtime:optional']),
    omnirouteScript: selectAvailableScript(scripts, ['prepare:omniroute-runtime', 'prepare:omniroute-runtime:optional']),
    buildProdScript: selectAvailableScript(scripts, ['build:prod', 'build:all', 'build']),
    smokeTestScript: selectAvailableScript(scripts, ['package:smoke-test', 'smoke-test'])
  };
  const hasElectronBuilderRunner = await pathExists(path.join(desktopWorkspace, 'scripts', 'run-electron-builder.js'));
  const canBuild = Boolean(
    fallbackScripts.runtimeScript &&
      fallbackScripts.toolchainScript &&
      fallbackScripts.codeServerScript &&
      fallbackScripts.omnirouteScript &&
      fallbackScripts.buildProdScript &&
      hasElectronBuilderRunner
  );

  return {
    packageJsonPath,
    packageJsonPresent: true,
    hasElectronBuilderRunner,
    canBuild,
    isCompatible: canBuild,
    scripts,
    fallbackScripts
  };
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

export function buildDesktopStoreSteps(overlayConfigPath, strategy, options = {}) {
  if (!strategy.canBuild) {
    throw new Error('Desktop workspace is missing the current Store packaging pipeline required by win_store_packer.');
  }

  const packerRepoRoot = options.packerRepoRoot;
  if (!packerRepoRoot) {
    throw new Error('buildDesktopStoreSteps requires options.packerRepoRoot for MSIX packaging.');
  }

  const platform = options.platform ?? process.platform;
  const steps = [];

  for (const scriptName of [
    strategy.fallbackScripts.runtimeScript,
    strategy.fallbackScripts.toolchainScript,
    strategy.fallbackScripts.codeServerScript,
    strategy.fallbackScripts.omnirouteScript,
    strategy.fallbackScripts.buildProdScript
  ]) {
    if (scriptName) {
      steps.push(createStep(`npm run ${scriptName}`, npmCommand(platform), ['run', scriptName]));
    }
  }

  steps.push(
    createStep(
      'node scripts/run-electron-builder.js --win dir --publish never',
      nodeCommand(platform),
      ['scripts/run-electron-builder.js', '--win', 'dir', '--publish', 'never', '--config', path.basename(overlayConfigPath)]
    )
  );

  steps.push(
    createStep(
      'node package-store-msix.mjs',
      nodeCommand(platform),
      [
        normalizeShellPath(path.join(packerRepoRoot, 'scripts', 'package-store-msix.mjs')),
        '--project-root',
        '.',
        '--config',
        path.basename(overlayConfigPath),
        '--input',
        path.join('pkg', 'win-unpacked'),
        '--output',
        'pkg',
        '--assets',
        path.join('resources', 'appx')
      ]
    )
  );

  if (strategy.fallbackScripts.smokeTestScript) {
    steps.push(createStep(`npm run ${strategy.fallbackScripts.smokeTestScript}`, npmCommand(platform), ['run', strategy.fallbackScripts.smokeTestScript]));
  }

  return steps;
}

export function buildDesktopStoreCommand(overlayConfigPath, strategy, options = {}) {
  const steps = buildDesktopStoreSteps(overlayConfigPath, strategy, options);
  return steps.map((step) => {
    if (step.command === 'npm' || step.command === 'npm.cmd') {
      return [step.command, ...step.args].join(' ');
    }

    if (step.command === 'node' || step.command === 'node.exe') {
      const serializedArgs = step.args.map((arg) => shellQuote(arg));
      return [step.command, ...serializedArgs].join(' ');
    }

    return [step.command, ...step.args.map((arg) => shellQuote(arg))].join(' ');
  }).join(' && ');
}

export async function shouldUseSyntheticDryRunBuild({ desktopWorkspace, planDryRun }) {
  if (!planDryRun) {
    return false;
  }

  const strategy = await resolveDesktopStoreBuildStrategy({ desktopWorkspace });

  return !strategy.isCompatible;
}
