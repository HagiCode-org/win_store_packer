import { spawn } from 'node:child_process';

export function shouldUseWindowsShell(command, shell, platform = process.platform) {
  if (platform !== 'win32') {
    return shell;
  }

  return Boolean(shell);
}

function normalizeStdio(stdio) {
  return stdio === 'pipe' ? 'pipe' : 'inherit';
}

function createExitError(command, args, code, signal, stdout, stderr) {
  const commandText = [command, ...args].join(' ');
  const statusText = signal ? `signal ${signal}` : `exit code ${code}`;
  const error = new Error(`Command failed with ${statusText}: ${commandText}`);
  error.exitCode = typeof code === 'number' ? code : 1;
  error.signal = signal ?? null;
  error.stdout = stdout;
  error.stderr = stderr;
  error.shortMessage = error.message;
  return error;
}

function spawnCommand(command, args = [], options = {}) {
  const { cwd, env, input, shell = false, stdio = 'inherit' } = options;
  const normalizedStdio = normalizeStdio(stdio);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: shouldUseWindowsShell(command, shell),
      stdio: normalizedStdio,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    if (normalizedStdio === 'pipe') {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (error) => {
      error.stdout ??= stdout;
      error.stderr ??= stderr;
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ code: 0, stdout, stderr });
        return;
      }

      reject(createExitError(command, args, code, signal, stdout, stderr));
    });

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

export async function runCommand(command, args = [], options = {}) {
  const result = await spawnCommand(command, args, options);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runCommandResult(command, args = [], options = {}) {
  try {
    const result = await spawnCommand(command, args, { ...options, stdio: 'pipe' });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      code: error.exitCode ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.shortMessage ?? String(error),
    };
  }
}
