import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export class ProviderSwitchError extends Error {}
export type ProviderMode = 'api' | 'chatgpt';
export interface ProviderStatus { mode: ProviderMode | 'unknown'; label: string; provider: string; }
const URLS = { api: 'https://token.brioi.com', chatgpt: 'https://chatgpt.com/backend-api/codex' };
const LABELS = { api: 'API Key（token.brioi.com）', chatgpt: 'ChatGPT 账号', unknown: '配置与凭据不匹配或尚未登录' };
interface Auth { auth_mode?: string; OPENAI_API_KEY?: string; tokens?: { access_token?: string; refresh_token?: string }; }
function authMode(auth: Auth): ProviderMode | 'unknown' {
  if (auth.auth_mode === 'chatgpt' && auth.tokens?.access_token && !auth.OPENAI_API_KEY) return 'chatgpt';
  if (auth.OPENAI_API_KEY && !auth.tokens && (auth.auth_mode === 'apikey' || !auth.auth_mode)) return 'api';
  return 'unknown';
}
function providerSection(config: string): { provider: string; start: number; end: number; text: string } {
  const root = config.split(/^\s*\[/m)[0] ?? '';
  const provider = /^\s*model_provider\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/m.exec(root)?.[1];
  if (provider !== 'OpenAI') throw new ProviderSwitchError('此切换器要求 model_provider 为 OpenAI，请先完成配置初始化。');
  const match = /^\[model_providers\.OpenAI\][^\S\r\n]*(?:#.*)?\r?$/m.exec(config);
  if (!match) throw new ProviderSwitchError('未找到 OpenAI 提供方配置。');
  const start = match.index;
  const tail = config.slice(start + match[0].length);
  const next = /^\s*\[/m.exec(tail);
  const end = next ? start + match[0].length + next.index : config.length;
  return { provider, start, end, text: config.slice(start, end) };
}
function modeFrom(config: string, auth: Auth): ProviderMode | 'unknown' {
  const section = providerSection(config);
  const url = /^\s*base_url\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/m.exec(section.text)?.[1];
  const mode = authMode(auth);
  return mode !== 'unknown' && url?.replace(/\/$/, '') === URLS[mode] ? mode : 'unknown';
}
async function readProviderStatus(home: string): Promise<ProviderStatus> {
  const config = await readFile(join(home, 'config.toml'), 'utf8');
  const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Auth;
  const mode = modeFrom(config, auth);
  return { mode, label: LABELS[mode], provider: 'OpenAI' };
}
async function hasPending(home: string): Promise<boolean> {
  try { await access(join(home, 'bridge-providers', 'pending.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function recoverPending(home: string): Promise<void> {
  if (!await hasPending(home)) return;
  const journal = join(home, 'bridge-providers', 'pending.json');
  const saved = JSON.parse(await readFile(journal, 'utf8')) as { config?: unknown; auth?: unknown };
  if (typeof saved.config !== 'string' || typeof saved.auth !== 'string' || modeFrom(saved.config, JSON.parse(saved.auth) as Auth) === 'unknown') {
    throw new ProviderSwitchError('切换恢复记录无效，已阻止启动 Codex，请检查服务器备份。');
  }
  await writeFileAtomic(join(home, 'auth.json'), saved.auth);
  await writeFileAtomic(join(home, 'config.toml'), saved.config);
  await rm(journal);
}
export async function recoverProviderSwitch(home: string): Promise<void> {
  if (!await hasPending(home)) return;
  const release = await lockfile.lock(home, { retries: 0, lockfilePath: join(home, 'bridge-providers', 'switch.lock') });
  try { await recoverPending(home); } finally { await release(); }
}
export async function getProviderStatus(home: string): Promise<ProviderStatus> {
  if (await hasPending(home)) throw new ProviderSwitchError('上次登录源切换未完成，请重试 /provider api 或 /provider chatgpt 以恢复。');
  return readProviderStatus(home);
}
export async function switchProvider(home: string, target: ProviderMode): Promise<ProviderStatus> {
  const vault = join(home, 'bridge-providers');
  await mkdir(vault, { recursive: true, mode: 0o700 });
  await chmod(vault, 0o700);
  const release = await lockfile.lock(home, { retries: 0, lockfilePath: join(vault, 'switch.lock') });
  try {
    await recoverPending(home);
    const configPath = join(home, 'config.toml');
    const authPath = join(home, 'auth.json');
    const config = await readFile(configPath, 'utf8');
    const oldAuth = await readFile(authPath, 'utf8');
    const current = modeFrom(config, JSON.parse(oldAuth) as Auth);
    if (current === 'unknown') throw new ProviderSwitchError('当前配置与登录凭据不匹配，未执行切换。');
    await writeFileAtomic(join(vault, `${current}.auth.json`), oldAuth);
    if (current === 'api') await writeFileAtomic(join(vault, 'api.provider.toml'), providerSection(config).text);
    if (current === target) return getProviderStatus(home);
    let targetAuth: string;
    try { targetAuth = await readFile(join(vault, `${target}.auth.json`), 'utf8'); }
    catch { throw new ProviderSwitchError(`尚未保存${LABELS[target]}凭据，请先在服务器完成该登录源的初始化；不要在飞书发送密钥。`); }
    if (authMode(JSON.parse(targetAuth) as Auth) !== target) throw new ProviderSwitchError('目标登录凭据类型不匹配，未执行切换。');
    const selected = providerSection(config);
    const section = target === 'api'
      ? await readFile(join(vault, 'api.provider.toml'), 'utf8')
      : '[model_providers.OpenAI]\nname = "OpenAI"\nbase_url = "https://chatgpt.com/backend-api/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n\n';
    const updated = config.slice(0, selected.start) + section + config.slice(selected.end);
    if (modeFrom(updated, JSON.parse(targetAuth) as Auth) !== target) throw new ProviderSwitchError('目标提供方配置不匹配，未执行切换。');
    const backup = join(vault, 'backups', `${Date.now()}-${randomUUID()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(backup, 'config.toml'), config);
    await writeFileAtomic(join(backup, 'auth.json'), oldAuth);
    if (await readFile(configPath, 'utf8') !== config || await readFile(authPath, 'utf8') !== oldAuth) throw new ProviderSwitchError('配置或凭据正在被其他进程更新，未执行切换。');
    const journal = join(vault, 'pending.json');
    await writeFileAtomic(journal, JSON.stringify({ config, auth: oldAuth }));
    try {
      await writeFileAtomic(authPath, targetAuth);
      await writeFileAtomic(configPath, updated);
      const status = await readProviderStatus(home);
      if (status.mode !== target) throw new ProviderSwitchError('登录源读回校验失败。');
      await rm(journal);
      return status;
    } catch (error) {
      await writeFileAtomic(authPath, oldAuth);
      await writeFileAtomic(configPath, config);
      await rm(journal);
      throw error;
    }
  } finally { await release(); }
}

