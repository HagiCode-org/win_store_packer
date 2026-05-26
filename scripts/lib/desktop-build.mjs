import path from 'node:path';
import { pathExists, readJson } from './fs-utils.mjs';

export function selectAvailableScript(scripts, candidates) {
  return candidates.find((scriptName) => typeof scripts?.[scriptName] === 'string') ?? null;
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

function shellQuote(value) {
  return JSON.stringify(String(value));
}

export function buildDesktopStoreCommand(overlayConfigPath, strategy, options = {}) {
  if (!strategy.canBuild) {
    throw new Error('Desktop workspace is missing the current Store packaging pipeline required by win_store_packer.');
  }

  const packerRepoRoot = options.packerRepoRoot;
  if (!packerRepoRoot) {
    throw new Error('buildDesktopStoreCommand requires options.packerRepoRoot for MSIX packaging.');
  }

  const commands = [];

  for (const scriptName of [
    strategy.fallbackScripts.runtimeScript,
    strategy.fallbackScripts.toolchainScript,
    strategy.fallbackScripts.codeServerScript,
    strategy.fallbackScripts.omnirouteScript,
    strategy.fallbackScripts.buildProdScript
  ]) {
    if (scriptName) {
      commands.push(`npm run ${scriptName}`);
    }
  }

  commands.push(`node scripts/run-electron-builder.js --win dir --publish never --config ${path.basename(overlayConfigPath)}`);
  commands.push(
    [
      'node',
      shellQuote(path.join(packerRepoRoot, 'scripts', 'package-store-msix.mjs')),
      '--project-root',
      shellQuote('.'),
      '--config',
      shellQuote(path.basename(overlayConfigPath)),
      '--input',
      shellQuote(path.join('pkg', 'win-unpacked')),
      '--output',
      shellQuote('pkg'),
      '--assets',
      shellQuote(path.join('resources', 'appx')),
    ].join(' ')
  );

  if (strategy.fallbackScripts.smokeTestScript) {
    commands.push(`npm run ${strategy.fallbackScripts.smokeTestScript}`);
  }

  return commands.join(' && ');
}

export async function shouldUseSyntheticDryRunBuild({ desktopWorkspace, planDryRun }) {
  if (!planDryRun) {
    return false;
  }

  const strategy = await resolveDesktopStoreBuildStrategy({ desktopWorkspace });

  return !strategy.isCompatible;
}
