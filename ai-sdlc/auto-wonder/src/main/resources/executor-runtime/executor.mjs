import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareCapsule, uploadArtifacts } from './capsule.mjs';
import { runEngine, validateModelOptions } from './engine.mjs';

const HEARTBEAT_MS = 5000;
const RECONNECT_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const FRAME_LIMIT = 1024 * 1024;
const PROTOCOL_FEATURES = ['TASK_PACKAGE_SIGNATURE_V1', 'TASK_MODEL_SELECTION_V1'];
const providers = new Set(['claude', 'codex', 'opencode']);
const memoryModes = new Set(['platform', 'provider-local', 'none']);
const id = (value) => Number.isSafeInteger(value) && value > 0;

export function parseLaunch(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'ws-url': { type: 'string' }, token: { type: 'string' }, 'executor-id': { type: 'string' },
    provider: { type: 'string' }, 'memory-mode': { type: 'string', default: 'platform' },
    'max-tasks': { type: 'string', default: '5' }, 'workspace-root': { type: 'string' },
    name: { type: 'string' }, debug: { type: 'boolean' },
    model: { type: 'string' }, 'reasoning-effort': { type: 'string' },
  } });
  const url = new URL(values['ws-url']);
  const executorId = Number(values['executor-id']);
  const capacity = Number(values['max-tasks']);
  const token = values.token ?? process.env.AUTOWONDER_EXECUTOR_TOKEN;
  if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/ws/executor'
      || url.username || url.password || url.search || url.hash || !token?.trim()
      || !id(executorId) || !providers.has(values.provider) || !memoryModes.has(values['memory-mode'])
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 10) {
    throw new Error('INVALID_EXECUTOR_LAUNCH');
  }
  validateModelOptions(values.provider, values.model, values['reasoning-effort']);
  const platform = new URL(url);
  platform.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.searchParams.set('executorId', String(executorId));
  url.searchParams.set('token', token);
  url.searchParams.set('maxConcurrentDispatches', String(capacity));
  if (values.name) url.searchParams.set('hostname', values.name);
  const configuredRoot = values['workspace-root'] || process.env.AUTOWONDER_WORKSPACE_ROOT;
  const workspaceRoot = configuredRoot === '~' ? homedir()
    : configuredRoot?.startsWith('~/') ? join(homedir(), configuredRoot.slice(2))
    : configuredRoot || join(homedir(), '.autowonder', 'local-executor', String(executorId));
  return { url, executorId, token, capacity, platformOrigin: platform.origin,
    provider: values.provider, memoryMode: values['memory-mode'], debug: values.debug,
    model: values.model, reasoningEffort: values['reasoning-effort'],
    root: resolve(workspaceRoot) };
}

function diagnostic(error) {
  const message = error?.message;
  return typeof message === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : 'EXECUTOR_TASK_FAILED';
}

export async function main(argv, version) {
  const launch = parseLaunch(argv);
  await mkdir(launch.root, { recursive: true, mode: 0o700 });
  const active = new Map();
  const pending = new Map();
  let socket, reconnect, heartbeat, connecting, stopping = false;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });

  function send(frame) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  function beat() {
    send({ type: 'HEARTBEAT', version, protocolFeatures: PROTOCOL_FEATURES,
      runningDispatchIds: [...active.keys(), ...pending.keys()] });
    for (const result of pending.values()) send(result);
  }

  async function dispatch(frame, controller) {
    const dispatchId = frame.dispatchId;
    let directory;
    let result;
    try {
      directory = await mkdtemp(join(launch.root, `task-${dispatchId}-`));
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TASK_TIMEOUT_MS)]);
      if (frame.resumeMode && frame.resumeMode !== 'none') throw new Error('EXECUTOR_RESUME_UNSUPPORTED');
      const capsule = await prepareCapsule(frame, directory, signal, launch.memoryMode);
      send({ type: 'TASK_PROGRESS', dispatchId, eventType: 'step.started', resultSummary: 'CLI execution started' });
      const summary = await runEngine(launch.provider, capsule, directory,
        { memoryMode: launch.memoryMode, model: frame.modelSelection?.model ?? launch.model,
          reasoningEffort: launch.reasoningEffort }, signal);
      await uploadArtifacts(frame, directory, launch.platformOrigin, launch.token, signal);
      result = { type: 'TASK_RESULT', dispatchId, success: true, resultSummary: summary };
    } catch (error) {
      const code = controller.signal.aborted ? 'EXECUTOR_TASK_STOPPED' : diagnostic(error);
      if (launch.debug) process.stderr.write(`Dispatch ${dispatchId} failed: ${code}\n`);
      result = { type: 'TASK_RESULT', dispatchId, success: false, error: code };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {
        process.stderr.write(`Could not remove task directory for dispatch ${dispatchId}\n`);
      });
      active.delete(dispatchId);
    }
    pending.set(dispatchId, result);
    send(result);
    if (stopping && active.size === 0) resolveStopped();
  }

  function onFrame(data) {
    if (typeof data !== 'string' || data.length > FRAME_LIMIT) return;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    const dispatchId = frame.dispatchId;
    if (frame.type === 'CONVERSATION_TURN' && id(frame.conversationId) && id(frame.turnId)) {
      send({ type: 'CONVERSATION_TURN_ACK', conversationId: frame.conversationId, turnId: frame.turnId,
        dispatchAttempt: frame.dispatchAttempt, status: 'FAILED', error: 'EXECUTOR_CONVERSATION_UNSUPPORTED' });
      return;
    }
    if (!id(dispatchId) || (frame.executorId != null && frame.executorId !== launch.executorId)) return;
    switch (frame.type) {
      case 'TASK_RESULT_ACK':
        if (frame.retryable !== true) pending.delete(dispatchId);
        break;
      case 'TASK_PAUSE':
        if (pending.has(dispatchId)) {
          send(pending.get(dispatchId));
        } else if (frame.cancel === true && active.has(dispatchId)) {
          active.get(dispatchId).abort();
        } else {
          send({ type: 'TASK_PAUSE_FAILED', dispatchId, error: 'EXECUTOR_CHECKPOINT_UNSUPPORTED' });
        }
        break;
      case 'TASK_DISPATCH': {
        if (pending.has(dispatchId)) {
          send(pending.get(dispatchId));
        } else if (active.has(dispatchId)) {
          send({ type: 'TASK_ACK', dispatchId });
        } else if (stopping || active.size + pending.size >= launch.capacity) {
          send({ type: 'TASK_BUSY', dispatchId });
        } else {
          const controller = new AbortController();
          active.set(dispatchId, controller);
          send({ type: 'TASK_ACK', dispatchId });
          void dispatch(frame, controller);
        }
        break;
      }
    }
  }

  function connect() {
    if (stopping) return;
    const current = new WebSocket(launch.url);
    socket = current;
    connecting = setTimeout(() => current.close(), CONNECT_TIMEOUT_MS);
    current.addEventListener('open', () => {
      clearTimeout(connecting);
      beat();
      heartbeat = setInterval(beat, HEARTBEAT_MS);
      if (launch.debug) process.stderr.write(`Connected executor ${launch.executorId} (${launch.provider})\n`);
    });
    current.addEventListener('message', (event) => onFrame(event.data));
    current.addEventListener('error', () => current.close());
    current.addEventListener('close', () => {
      clearTimeout(connecting);
      clearInterval(heartbeat);
      if (!stopping) reconnect = setTimeout(connect, RECONNECT_MS);
    });
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(reconnect);
    clearTimeout(connecting);
    clearInterval(heartbeat);
    for (const controller of active.values()) controller.abort();
    if (active.size === 0) resolveStopped();
  }

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    connect();
    await stopped;
  } finally {
    socket?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${diagnostic(error)}\n`);
    process.exitCode = 1;
  });
}
