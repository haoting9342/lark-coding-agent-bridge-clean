import { accessSync, constants as fsConstants } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { repairCodexHistory } from '../../runtime/codex-history-repair';
import { homedir } from 'node:os';
import { recoverProviderSwitch } from '../../runtime/codex-provider';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { delimiter, join, resolve } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixCodexBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildCodexArgs } from './argv';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const LINUX_STDOUT_SETUP = [
  'import fcntl, os, socket, sys',
  'try:',
  '    stdout_socket = socket.socket(fileno=1)',
  '    try:',
  '        stdout_socket.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)',
  '    except OSError:',
  '        pass',
  '    stdout_socket.detach()',
  'except OSError:',
  '    pass',
  'try:',
  '    flags = fcntl.fcntl(1, fcntl.F_GETFL)',
  '    fcntl.fcntl(1, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)',
  'except OSError:',
  '    pass',
  'os.execvp(sys.argv[1], sys.argv[1:])',
].join('\n');

const MAX_CAPACITY_RETRIES = 3;
const CAPACITY_RETRY_BASE_DELAY_MS = 250;

function findExecutableInPath(name: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory || process.cwd(), name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH entries.
    }
  }
  return undefined;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly runningChildren = new Set<CodexChild>();
  private readonly childThreads = new Map<CodexChild, string>();
  private readonly repairingThreads = new Set<string>();
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  hasRunningProcesses(): boolean { return this.runningChildren.size > 0; }

  private effectiveHome(): string {
    return this.codexHome ?? (this.inheritCodexHome
      ? process.env.CODEX_HOME ?? join(homedir(), '.codex')
      : join(this.profileStateDir, 'codex-home'));
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    await recoverProviderSwitch(this.effectiveHome());
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (opts.threadId && this.repairingThreads.has(opts.threadId)) throw new Error('当前会话正在修复，请稍后重试。');
    let outputStarted = false;
    let currentThreadId = opts.threadId;
    let current = this.runOnce(opts, () => { outputStarted = true; });
    let capacityRetries = 0;
    let stopped = false;
    const adapter = this;
    return {
      runId: opts.runId,
      async stop() { stopped = true; await current.stop(); },
      waitForExit(timeoutMs) { return current.waitForExit(timeoutMs); },
      events: (async function* (): AsyncGenerator<AgentEvent> {
        for (;;) {
          let retryCapacity = false;
          for await (const event of current.events) {
            if (event.type === 'system' && event.threadId) currentThreadId = event.threadId;
            if (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'text' || event.type === 'final_text') outputStarted = true;

            if (
              event.type === 'error' &&
              event.terminationReason === 'failed' &&
              !outputStarted &&
              !stopped &&
              capacityRetries < MAX_CAPACITY_RETRIES &&
              isCapacityError(event.message)
            ) {
              // Capacity errors occur before a usable response. Drain the
              // failed child before retrying the same request, so no two
              // writers can overlap and no partial tool activity is replayed.
              if (!await current.waitForExit(5000)) { await current.stop(); }
              if (!await current.waitForExit(1000)) { yield event; return; }
              capacityRetries++;
              const delayMs = CAPACITY_RETRY_BASE_DELAY_MS * (2 ** (capacityRetries - 1));
              log.warn('agent', 'capacity-retry', {
                attempt: capacityRetries,
                maxAttempts: MAX_CAPACITY_RETRIES,
                delayMs,
                runId: opts.runId,
              });
              await delay(delayMs);
              if (stopped) {
                yield { type: 'done', threadId: opts.threadId, terminationReason: 'interrupted' };
                return;
              }
              current = adapter.runOnce(opts, () => { outputStarted = true; });
              retryCapacity = true;
              break;
            }

            const home = adapter.effectiveHome();
            const eligible = event.type === 'error' && event.terminationReason === 'failed' && !outputStarted && !stopped
              && currentThreadId && isHistoryIdCompatibilityError(event.message)
              && resolve(home) === resolve(join(adapter.profileStateDir, 'provider-codex-home'));
            if (!eligible) { yield event; continue; }
            // Finish the failed writer before touching its rollout; keep the logical run active.
            if (!await current.waitForExit(5000)) { await current.stop(); }
            if (!await current.waitForExit(1000)) { yield event; return; }
            if (stopped) { yield { type: 'done', threadId: opts.threadId, terminationReason: 'interrupted' }; return; }
            const threadId = currentThreadId!;
            if ([...adapter.childThreads.values()].includes(threadId) || adapter.repairingThreads.has(threadId)) {
              yield { type: 'error', message: '当前会话仍有其他任务运行，暂时无法自动修复。请稍后重试。', terminationReason: 'failed' }; return;
            }
            adapter.repairingThreads.add(threadId);
            try {
              if ((await lstat(home)).isSymbolicLink()) throw new Error('Linked home');
              yield { type: 'text', delta: '正在修复当前会话，完成后继续原指令。\n\n' };
              if (!stopped) {
                const result = await repairCodexHistory(home, threadId);
                if (!result.removedIds) throw new Error('No compatible repair found');
                log.info('agent', 'history-repaired', { threadId, files: result.files, removedIds: result.removedIds, backupDir: result.backupDir });
              }
            } catch {
              yield { type: 'error', message: '当前会话未能安全修复，原指令尚未继续。请检查该会话的历史备份。', terminationReason: 'failed' }; return;
            } finally { adapter.repairingThreads.delete(threadId); }
            if (stopped) { yield { type: 'done', threadId, terminationReason: 'interrupted' }; return; }
            current = adapter.runOnce(opts, () => { outputStarted = true; });
            // A single retry bounds recovery and prevents loops on a different upstream problem.
            for await (const retried of current.events) {
              if (retried.type === 'error' && isHistoryIdCompatibilityError(retried.message)) {
                yield { type: 'error', message: '会话修复后仍未能继续，已停止自动重试；原指令尚未完成。', terminationReason: 'failed' };
              } else yield retried;
            }
            return;
          }
          if (!retryCapacity) return;
        }
      })(),
    };
  }

  private runOnce(opts: AgentRunOptions, onActivity?: () => void): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    const args = buildCodexArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const env = mergeProcessEnv(process.env, envOverrides);
    const python3 = process.platform === 'linux' ? findExecutableInPath('python3', env.PATH) : undefined;
    const command = python3
      ? { binary: python3, args: ['-c', LINUX_STDOUT_SETUP, this.binary, ...args] }
      : { binary: this.binary, args };
    const child = spawnProcess(command.binary, command.args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    this.runningChildren.add(child);
    if (opts.threadId) this.childThreads.set(child, opts.threadId);
    child.once('exit', () => this.childThreads.delete(child));
    child.once('error', () => { if (!child.pid) this.childThreads.delete(child); });
    child.once('exit', () => this.runningChildren.delete(child));
    child.once('error', () => { if (!child.pid) this.runningChildren.delete(child); });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixCodexBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason, onActivity),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
  onActivity?: () => void,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeExitedStdout = (): void => {
    // Some Codex startup failures only write stderr and leave stdout open.
    // Close the pipe after the process exits so readline terminates and the
    // fanout cleanup releases the scope and process-pool slot.
    silentExitTimer = setTimeout(() => {
      if (!child.stdout.readableEnded) child.stdout.destroy();
    }, sawStdout ? 250 : 50);
  };
  child.once('exit', closeExitedStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Some Codex tool item types are not rendered by the translator yet.
      // Still count them as activity so recovery cannot replay their effects.
      const raw = parsed as { type?: string; item?: { type?: string } } | null;
      if (raw && (raw.type === 'item.started' || raw.type === 'item.completed') && raw.item?.type !== 'reasoning') onActivity?.();
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeExitedStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`codex runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`codex runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

export function isHistoryIdCompatibilityError(message: string): boolean {
  return /invalid[\s\S]*?(?:input\[\d+\]\.id|\bid\b)[\s\S]*?item_[a-z0-9_-]+[\s\S]*?expected\s+an?\s+id\s+that\s+begins\s+with\s+['"][a-z][a-z0-9_-]*['"]/i.test(message);
}

export function isCapacityError(message: string): boolean {
  return /selected\s+model\s+is\s+at\s+capacity|model\s+is\s+at\s+capacity|currently\s+overloaded|temporarily\s+overloaded|over\s+capacity|upstream\s+overload/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
