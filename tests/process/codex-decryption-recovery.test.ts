import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent } from '../../src/agent/types';

const threadId = '01a180ef-6b70-7891-8197-7262436638c9';
const functionFailure = 'stream disconnected before completion: Encrypted function output content could not be decrypted or decoded.';
const compactionFailure = 'stream disconnected before completion: The encrypted content for item cmp_example could not be verified. Reason: Encrypted content could not be decrypted or parsed.';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function fixture(options: {
  failures: string[];
  encoded?: boolean;
  persistent?: boolean;
  activity?: 'command_execution' | 'mcp_tool_call' | 'agent_message';
  activityAttempt?: number;
  lateActivity?: boolean;
  requestedThread?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'decryption-recovery-')); dirs.push(root);
  const home = join(root, 'provider-codex-home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const file = join(home, 'sessions', `rollout-${threadId}.jsonl`);
  const original = [
    { type: 'session_meta', payload: { id: threadId } },
    { type: 'response_item', payload: options.encoded
      ? { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'c2a-msg-v1:' + Buffer.from('保留原会话内容').toString('base64') }] }
      : { type: 'compaction', id: 'cmp_example', encrypted_content: 'opaque-real-ciphertext' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(file, original);
  const binary = join(root, 'fake.mjs');
  const records = join(root, 'runs.jsonl');
  const active = join(root, 'active');
  const exits = join(root, 'exits');
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
let prompt = ''; for await (const part of process.stdin) prompt += part;
const records = ${JSON.stringify(records)}, active = ${JSON.stringify(active)};
const attempt = existsSync(records) ? readFileSync(records, 'utf8').trim().split('\\n').length : 0;
appendFileSync(records, JSON.stringify({ args: process.argv.slice(2), prompt, overlap: existsSync(active) }) + '\\n');
writeFileSync(active, 'running');
console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }));
const failures = ${JSON.stringify(options.failures)};
let failure = failures[attempt] ?? (${!!options.persistent} ? failures.at(-1) : undefined);
if (${!!options.encoded} && readFileSync(${JSON.stringify(file)}, 'utf8').includes('c2a-msg-v1:')) failure = ${JSON.stringify(functionFailure)};
if (failure) {
  if (${JSON.stringify(options.activity ?? '')} && attempt === ${options.activityAttempt ?? 0}) {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: ${JSON.stringify(options.activity ?? '')}, id: 'activity', text: 'partial output', command: 'touch result' } }));
  }
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: failure } }));
  if (${!!options.lateActivity}) setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'late-effect' } })), 25);
} else {
  console.log(JSON.stringify({ type: 'agent_message', message: 'recovered' }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
setTimeout(() => {
  unlinkSync(active); appendFileSync(${JSON.stringify(exits)}, String(attempt) + '\\n');
  process.exit(failure ? 1 : 0);
}, 100);
`);
  await chmod(binary, 0o755);
  const adapter = new CodexAdapter({ binary, profileStateDir: root, codexHome: home });
  const run = adapter.run({ cwd: root, runId: 'decryption', threadId: options.requestedThread ?? threadId, model: 'test-model', prompt: 'original business request', images: ['/tmp/input.png'] });
  return { run, file, original, records, exits, adapter, root };
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result;
}
async function attempts(path: string) { return (await readFile(path, 'utf8')).trim().split('\n').map(row => JSON.parse(row)); }

it.each([compactionFailure, functionFailure])('retries transient decryption without rewriting opaque history: %s', async failure => {
  const h = await fixture({ failures: [failure] });
  const events = await collect(h.run.events);
  expect(events.some(e => e.type === 'error')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'done', threadId, terminationReason: 'normal' });
  const runs = await attempts(h.records);
  expect(runs).toHaveLength(2); expect(runs[1]).toEqual(runs[0]);
  expect(runs.every(r => !r.overlap)).toBe(true);
  expect(await readFile(h.file, 'utf8')).toBe(h.original);
});

it('can retry a compaction failure after repairing encoded messages in the same logical run', async () => {
  const h = await fixture({ encoded: true, failures: [functionFailure, compactionFailure] });
  const events = await collect(h.run.events);
  expect(events.some(e => e.type === 'error')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'done', threadId, terminationReason: 'normal' });
  expect(await attempts(h.records)).toHaveLength(3);
  expect(await readFile(h.file, 'utf8')).toContain('保留原会话内容');
});

it('bounds decryption retries to two and retains the original upstream error when exhausted', async () => {
  const h = await fixture({ failures: [compactionFailure], persistent: true });
  const events = await collect(h.run.events); await h.run.waitForExit(1000);
  expect(await attempts(h.records)).toHaveLength(3);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: compactionFailure });
  expect(await readFile(h.file, 'utf8')).toBe(h.original);
}, 10000);

it('uses the actual started thread on retry instead of reopening a stale requested thread', async () => {
  const h = await fixture({ failures: [compactionFailure], requestedThread: '01a180ef-6b70-7891-8197-726243663899' });
  const events = await collect(h.run.events);
  expect(events.at(-1)).toMatchObject({ type: 'done', threadId, terminationReason: 'normal' });
  const runs = await attempts(h.records); expect(runs).toHaveLength(2);
  expect(runs[1].args).toContain(threadId); expect(runs[1].args).not.toContain('01a180ef-6b70-7891-8197-726243663899');
  expect(runs[1].prompt).toBe(runs[0].prompt);
});

it.each(['command_execution', 'mcp_tool_call', 'agent_message'] as const)('does not replay after %s activity', async activity => {
  const h = await fixture({ failures: [compactionFailure], activity });
  const events = await collect(h.run.events); await h.run.waitForExit(1000);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: compactionFailure });
  expect(await attempts(h.records)).toHaveLength(1);
});

it('keeps the no-replay guard after a successful history repair', async () => {
  const h = await fixture({ encoded: true, failures: [functionFailure, compactionFailure], activity: 'mcp_tool_call', activityAttempt: 1 });
  const events = await collect(h.run.events); await h.run.waitForExit(1000);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: compactionFailure });
  expect(await attempts(h.records)).toHaveLength(2);
});

it.each([compactionFailure, functionFailure, 'Selected model is at capacity. Please try a different model.'])('drains late activity before deciding to replay: %s', async failure => {
  const h = await fixture({ failures: [failure], lateActivity: true });
  const events = await collect(h.run.events); await h.run.waitForExit(1000);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: failure });
  expect(await attempts(h.records)).toHaveLength(1);
});

it('honors stop while announcing a decryption retry', async () => {
  const h = await fixture({ failures: [compactionFailure] });
  const events: AgentEvent[] = [];
  for await (const event of h.run.events) {
    events.push(event);
    if (event.type === 'text' && event.delta.includes('重试')) await h.run.stop();
  }
  expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  expect(await attempts(h.records)).toHaveLength(1);
});

it.each([compactionFailure, functionFailure])('holds the thread lock throughout retry notifications and backoff: %s', async failure => {
  const h = await fixture({ failures: [failure] });
  let rejected = false;
  const events: AgentEvent[] = [];
  for await (const event of h.run.events) {
    events.push(event);
    if (event.type === 'text' && event.delta.includes('重试')) {
      let competing;
      try { competing = h.adapter.run({ cwd: h.root, runId: 'competing', threadId, prompt: 'competing request' }); }
      catch { rejected = true; }
      if (competing) await competing.stop();
    }
  }
  expect(rejected).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'done', threadId, terminationReason: 'normal' });
  expect(await attempts(h.records)).toHaveLength(2);
});

it.each(['401 authentication failed', 'Encrypted content for item rs_example could not be verified.', 'network disconnected'])('does not classify unrelated errors as recoverable: %s', async failure => {
  const h = await fixture({ failures: [failure] });
  const events = await collect(h.run.events); await h.run.waitForExit(1000);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: failure });
  expect(await attempts(h.records)).toHaveLength(1);
});
