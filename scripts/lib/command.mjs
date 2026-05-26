import { execa } from 'execa';

export function shouldUseWindowsShell(command, shell, platform = process.platform) {
  if (platform !== 'win32') {
    return shell;
  }

  return Boolean(shell);
}

function buildStdio(stdio) {
  return stdio === 'pipe' ? 'pipe' : stdio;
}

export async function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env,
    input,
    shell = false,
    stdio = 'inherit'
  } = options;

  const result = await execa(command, args, {
    cwd,
    env,
    input,
    shell: shouldUseWindowsShell(command, shell),
    stdio: buildStdio(stdio),
    reject: true
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

export async function runCommandResult(command, args = [], options = {}) {
  const {
    cwd,
    env,
    input,
    shell = false
  } = options;

  try {
    const result = await execa(command, args, {
      cwd,
      env,
      input,
      shell: shouldUseWindowsShell(command, shell),
      stdio: 'pipe',
      reject: true
    });

    return {
      code: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    };
  } catch (error) {
    return {
      code: error.exitCode ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.shortMessage ?? String(error)
    };
  }
}
