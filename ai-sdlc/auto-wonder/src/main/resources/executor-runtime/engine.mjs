import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 4096;
const KILL_GRACE_MS = 2000;

const HOST_ENV = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
const CLAUDE_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_GZIP_REQUEST_BODIES', 'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
];

function copyEnv(names, source, target) {
  for (const name of names) {
    if (typeof source?.[name] === 'string') target[name] = source[name];
  }
}

async function claudeCommand(env, memoryMode) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let settings;
  try {
    settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('CLAUDE_SETTINGS_INVALID');
  }
  copyEnv([...CLAUDE_ENV, 'NODE_EXTRA_CA_CERTS'], settings?.env, env);
  copyEnv(CLAUDE_ENV, process.env, env);
  env.CLAUDE_CONFIG_DIR = configDir;

  const args = [
    '--print', '--output-format', 'json', '--restricted', '--safe-mode', '--strict-mcp-config',
    '--permission-mode', 'acceptEdits', '--tools', 'Read,Write,Edit,Glob,Grep',
  ];
  if (memoryMode !== 'provider-local') args.push('--no-session-persistence');
  if (!env.ANTHROPIC_MODEL && typeof settings?.model === 'string' && settings.model.trim()) {
    args.push('--model', settings.model);
  }
  return { binary: 'claude', args, readSummary: claudeSummary };
}

function claudeSummary(output) {
  const result = JSON.parse(output);
  if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false
      || typeof result.result !== 'string') {
    throw new Error('CLAUDE_TURN_FAILED');
  }
  return result.result;
}

function taskPrompt(capsule, memoryMode) {
  const step = capsule.sdlc.steps?.find(item => String(item.id) === String(capsule.sdlc.currentStepId));
  return [
    'Execute the assigned AutoWonder work item in the current task directory.',
    'Read workitem.md and identity.json. Use the current step in sdlc.json and the applicable task context files described by manifest.json.',
    'Follow the repository and capability policies in policy.json and skills.json. Keep credentials and unrelated local files out of the task.',
    memoryMode === 'platform' ? 'Use the provided memory files in memory/ when present.' : '',
    'Write deliverable files under artifacts/output/. Return a concise summary after verifying the result.',
    typeof step?.instruction === 'string' && step.instruction.trim() ? 'Current step instruction:\n' + step.instruction : '',
  ].filter(Boolean).join('\n\n');
}

function stopProcess(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill(signal);
  }
}

function runCli(command, directory, env, prompt, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      cwd: directory,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0;
    let failure;
    let killTimer;

    function stop(error) {
      if (failure) return;
      failure = error;
      stopProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }

    const abort = () => stop(new Error('EXECUTOR_CLI_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_CLI_OUTPUT_BYTES) {
        stop(new Error('EXECUTOR_CLI_OUTPUT_TOO_LARGE'));
      } else {
        chunks.push(chunk);
      }
    });
    child.once('error', error => {
      failure ??= new Error(error.code === 'ENOENT' ? 'EXECUTOR_CLI_NOT_FOUND' : 'EXECUTOR_CLI_START_FAILED');
    });
    child.once('close', code => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(new Error('EXECUTOR_CLI_FAILED'));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    child.stdin.end(prompt);
  });
}

export async function runEngine(provider, capsule, directory, { memoryMode }, signal) {
  const env = {};
  copyEnv(HOST_ENV, process.env, env);
  let command;
  switch (provider) {
    case 'claude':
      command = await claudeCommand(env, memoryMode);
      break;
    default:
      throw new Error('EXECUTOR_PROVIDER_UNSUPPORTED');
  }

  const output = await runCli(command, directory, env, taskPrompt(capsule, memoryMode), signal);
  try {
    let summary = command.readSummary(output).trim();
    for (const [name, value] of Object.entries(env)) {
      if (value && /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(name)) {
        summary = summary.replaceAll(value, '[redacted]');
      }
    }
    return summary.slice(0, MAX_SUMMARY_LENGTH);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('EXECUTOR_CLI_OUTPUT_INVALID');
    throw error;
  }
}
