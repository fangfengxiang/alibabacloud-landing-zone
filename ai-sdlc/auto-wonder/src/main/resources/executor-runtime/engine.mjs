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
const OPENCODE_ENV = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'DASHSCOPE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
];
const OPENCODE_MIN_VERSION = [2, 2, 3];
const OPENCODE_FILE_ACTIONS = ['read', 'edit', 'glob', 'grep'];
const OPENCODE_DISABLED_INTEGRATIONS = ['plugin.use', 'mcp.use', 'skill.use'];
const CODEX_ENV = ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY'];
const MAX_MODEL_ID_LENGTH = 200;
const MODEL_ID = /^[A-Za-z0-9_.:/+][A-Za-z0-9_.:/+-]*$/;
const OPENCODE_MODEL_ID = /^[A-Za-z0-9_.:/+][A-Za-z0-9_.:/+-]*(?:#[A-Za-z0-9_.+-]+)?$/;
const REASONING_EFFORTS = new Map([
  ['claude', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['codex', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
]);

export function validateModelOptions(provider, model, reasoningEffort) {
  const modelPattern = provider === 'opencode' ? OPENCODE_MODEL_ID : MODEL_ID;
  if (model != null && (typeof model !== 'string' || model.length > MAX_MODEL_ID_LENGTH
      || model !== model.trim() || !modelPattern.test(model))) {
    throw new Error('EXECUTOR_MODEL_INVALID');
  }
  if (reasoningEffort != null && !REASONING_EFFORTS.get(provider)?.includes(reasoningEffort)) {
    throw new Error('EXECUTOR_EFFORT_UNSUPPORTED');
  }
}

function copyEnv(names, source, target) {
  for (const name of names) {
    if (typeof source?.[name] === 'string') target[name] = source[name];
  }
}

async function claudeCommand(env, memoryMode, model, reasoningEffort) {
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
  const selectedModel = model ?? (env.ANTHROPIC_MODEL ? null : settings?.model);
  if (typeof selectedModel === 'string' && selectedModel.trim()) args.push('--model', selectedModel);
  if (reasoningEffort) args.push('--effort', reasoningEffort);
  return { binary: 'claude', args, readSummary: claudeSummary };
}

function codexCommand(env, memoryMode, model, reasoningEffort) {
  copyEnv(CODEX_ENV, process.env, env);
  const args = [
    '--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check',
    '--json', '--color', 'never',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.exclude=["*TOKEN*","*KEY*","*SECRET*","*PASSWORD*","*CREDENTIAL*"]',
  ];
  if (memoryMode !== 'provider-local') args.push('--ephemeral');
  if (model) args.push('--model', model);
  if (reasoningEffort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(reasoningEffort));
  args.push('-');
  return { binary: 'codex', args, readSummary: codexSummary };
}

function opencodeCommand(env, memoryMode, directory, model) {
  copyEnv(OPENCODE_ENV, process.env, env);
  env.PWD = directory;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      ...OPENCODE_FILE_ACTIONS.map(action => ({ action, resource: '*', effect: 'allow' })),
      { action: 'external_directory', resource: '*', effect: 'deny' },
    ],
    policies: OPENCODE_DISABLED_INTEGRATIONS.map(action => ({ action, resource: '*', effect: 'deny' })),
  });
  if (memoryMode !== 'provider-local') env.OPENCODE_DB = ':memory:';
  const args = ['run', '--standalone', '--format', 'json', '--archived'];
  if (model) args.push('--model', model);
  return { binary: 'opencode', args, readSummary: opencodeSummary };
}

function opencodeSummary(output) {
  let finishReason;
  const summary = [];
  for (const line of output.trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error('OPENCODE_TURN_FAILED');
    if (event.type === 'step_start') finishReason = undefined;
    if (event.type === 'step_finish') finishReason = event.part?.reason;
    if (event.type === 'text' && typeof event.part?.text === 'string') summary.push(event.part.text);
  }
  if (finishReason !== 'stop' || !summary.length) throw new Error('OPENCODE_TURN_FAILED');
  return summary.join('\n');
}

function claudeSummary(output) {
  const result = JSON.parse(output);
  if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false
      || typeof result.result !== 'string') {
    throw new Error('CLAUDE_TURN_FAILED');
  }
  return result.result;
}

function codexSummary(output) {
  let completed = false;
  let summary;
  for (const line of output.trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.type === 'turn.failed') throw new Error('CODEX_TURN_FAILED');
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string') summary = event.item.text;
  }
  if (!completed || summary === undefined) throw new Error('CODEX_TURN_FAILED');
  return summary;
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

export async function runEngine(provider, capsule, directory, { memoryMode, model, reasoningEffort }, signal) {
  validateModelOptions(provider, model, reasoningEffort);
  const env = {};
  copyEnv(HOST_ENV, process.env, env);
  let command;
  switch (provider) {
    case 'claude':
      command = await claudeCommand(env, memoryMode, model, reasoningEffort);
      break;
    case 'codex':
      command = codexCommand(env, memoryMode, model, reasoningEffort);
      break;
    case 'opencode': {
      command = opencodeCommand(env, memoryMode, directory, model);
      const version = await runCli({ ...command, args: ['--version'] }, directory, env, '', signal);
      const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)$/i.exec(version.trim());
      const current = match?.slice(1).map(Number);
      const difference = current?.findIndex((part, index) => part !== OPENCODE_MIN_VERSION[index]);
      if (!current || (difference >= 0 && current[difference] < OPENCODE_MIN_VERSION[difference])) {
        throw new Error('OPENCODE_VERSION_UNSUPPORTED');
      }
      break;
    }
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
