import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export interface HistoryRepairResult { files: number; removedIds: number; backupDir?: string; }
async function* lines(path: string): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let start = 0;
    for (let i = 0; i < pending.length; i++) if (pending[i] === 10) {
      yield pending.subarray(start, i + 1); start = i + 1;
    }
    pending = Buffer.from(pending.subarray(start));
    if (pending.length > 64 * 1024 * 1024) throw new Error('History line exceeds repair limit');
  }
  if (pending.length) yield pending;
}
async function hash(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function* rollouts(path: string): AsyncGenerator<string> {
  let stat;
  try { stat = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  if (stat.isSymbolicLink()) throw new Error('Linked history is not supported');
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) yield* rollouts(join(path, entry));
  } else if (path.endsWith('.jsonl') && stat.isFile()) yield path;
}

/** Caller must prevent writers to this thread until repair completes. Other threads are untouched. */
export async function repairCodexHistory(home: string, threadId: string): Promise<HistoryRepairResult> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId)) throw new Error('Invalid thread ID');
  if ((await lstat(home)).isSymbolicLink()) throw new Error('Linked home is not supported');
  const matches: string[] = [];
  for (const tree of ['sessions', 'archived_sessions']) for await (const file of rollouts(join(home, tree))) {
    if (file.endsWith(`-${threadId}.jsonl`)) matches.push(file);
  }
  if (matches.length !== 1) throw new Error('Expected exactly one current rollout');
  const result: HistoryRepairResult = { files: 0, removedIds: 0 };
  for (const file of matches) {
    const patches: { offset: number; length: number }[] = [];
    const before = createHash('sha256'), after = createHash('sha256');
    let offset = 0;
    let checkedIdentity = false;
    for await (const raw of lines(file)) {
      before.update(raw);
      let output = raw;
      const text = raw.toString('utf8');
      if (text.trim()) {
        const row = JSON.parse(text);
        if (!checkedIdentity) {
          if (row.type !== 'session_meta' || row.payload?.id !== threadId) throw new Error('Rollout identity mismatch');
          checkedIdentity = true;
        }
        if (row.type === 'response_item' && typeof row.payload?.id === 'string' && row.payload.id.startsWith('item_')) {
          const expected = structuredClone(row); delete expected.payload.id;
          // Validate the whole parsed record to distinguish the top-level payload ID from nested IDs.
          const pattern = /"id"\s*:\s*"item_[^"\\]*"\s*,|,\s*"id"\s*:\s*"item_[^"\\]*"/g;
          let found = false;
          for (const match of text.matchAll(pattern)) {
            const start = Buffer.byteLength(text.slice(0, match.index));
            const length = Buffer.byteLength(match[0]);
            const candidate = Buffer.from(raw); candidate.fill(32, start, start + length);
            try { if (!isDeepStrictEqual(JSON.parse(candidate.toString('utf8')), expected)) continue; } catch { continue; }
            output = candidate; patches.push({ offset: offset + start, length }); found = true; break;
          }
          if (!found) throw new Error('Cannot safely remove history ID');
        }
      }
      after.update(output); offset += raw.length;
    }
    if (!patches.length) continue;
    const originalHash = before.digest('hex'), expectedHash = after.digest('hex');
    result.backupDir ??= join(home, 'bridge-providers', 'history-backups', `${Date.now()}-${randomUUID()}`);
    const backup = join(result.backupDir, relative(home, file));
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await copyFile(file, backup); await chmod(backup, 0o600);
    if (await hash(backup) !== originalHash) throw new Error('History changed during backup');
    const temp = `${file}.repair-${randomUUID()}`;
    try {
      await copyFile(backup, temp); await chmod(temp, 0o600);
      const handle = await open(temp, 'r+');
      try {
        for (const patch of patches) {
          const bytes = Buffer.alloc(patch.length, 32);
          let written = 0;
          while (written < bytes.length) {
            const part = await handle.write(bytes, written, bytes.length - written, patch.offset + written);
            if (!part.bytesWritten) throw new Error('History patch write failed');
            written += part.bytesWritten;
          }
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (await hash(temp) !== expectedHash || await hash(file) !== originalHash) throw new Error('History verification failed');
      await rename(temp, file);
      const dir = await open(dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
    result.files++; result.removedIds += patches.length;
  }
  return result;
}
