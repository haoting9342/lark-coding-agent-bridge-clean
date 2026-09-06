import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface SentMessage {
  chatId: string;
  content: unknown;
  options?: unknown;
  messageId: string;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: SentMessage[];
  createdCards: unknown[];
  updateAttempts: Array<{ cardId: string; card: unknown; sequence: number }>;
  streamCalls: unknown[];
  recalledMessageIds: string[];
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: { v6: { application: { get: ReturnType<typeof vi.fn> } } };
    im: { v1: {
      message: { get: ReturnType<typeof vi.fn> };
      messageReaction: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    } };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  createCard(card: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, card: unknown, sequence: number): Promise<void>;
  updateCard(messageId: string, card: unknown): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<unknown>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('managed Codex process cards', () => {
  it('uses a signed managed process card by default and preserves final delivery after a degraded update', async () => {
    const h = await createHarness();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_trigger', 'run'));
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('FINAL_SENTINEL')));

    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.streamCalls).toHaveLength(0);
    const runningCard = JSON.stringify(h.channel.createdCards[0]);
    expect(runningCard).toContain('"cmd":"stop"');
    expect(runningCard).toContain('"__bridge_cb":true');
    expect(runningCard).toContain('"bridge_token"');

    expect(h.channel.updateAttempts).toHaveLength(6);
    expect(h.channel.updateAttempts.slice(0, 3).map((attempt) => attempt.sequence)).toEqual([1, 1, 1]);
    expect(warn.mock.calls.some((call) =>
      call[0] === 'card'
      && call[1] === 'process-card-update-degraded'
      && (call[2] as { scope?: string } | undefined)?.scope === 'oc_dm')).toBe(true);

    const processMessage = h.channel.sent.find((item) => JSON.stringify(item.content).includes('"cmd":"stop"'));
    expect(processMessage).toBeDefined();
    expect(h.channel.recalledMessageIds).toEqual([processMessage?.messageId]);
    const finalMessages = h.channel.sent.filter((item) => JSON.stringify(item.content).includes('FINAL_SENTINEL'));
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.messageId).not.toBe(processMessage?.messageId);
    expect(finalMessages[0]?.options).toMatchObject({ replyTo: 'om_trigger' });
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('managed-process-card-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    codex: { binaryPath: '/usr/local/bin/codex' },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: { ...baseProfileConfig.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: [
      { type: 'text', delta: 'progress update' },
      { type: 'final_text', content: 'FINAL_SENTINEL' },
      { type: 'done', terminationReason: 'normal' },
    ],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

async function startTestBridge(h: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: {
      secretsFile: join(h.tmp.profile, 'secrets.json'),
      keystoreSaltFile: join(h.tmp.profile, 'keystore.salt'),
      mediaDir: join(h.tmp.profile, 'media'),
    },
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: SentMessage[] = [];
  const createdCards: unknown[] = [];
  const updateAttempts: FakeLarkChannel['updateAttempts'] = [];
  const streamCalls: unknown[] = [];
  const recalledMessageIds: string[] = [];
  const cardById = new Map<string, unknown>();
  let nextMessage = 1;
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    createdCards,
    updateAttempts,
    streamCalls,
    recalledMessageIds,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: { v6: { application: { get: vi.fn(async () => ({
        data: { app: { owner: { owner_id: 'ou_owner' } } },
      })) } } },
      im: { v1: {
        message: { get: vi.fn(async () => ({ data: { items: [] } })) },
        messageReaction: {
          create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
          delete: vi.fn(async () => ({})),
        },
      } },
    },
    on(nextHandlers) { Object.assign(handlers, nextHandlers); },
    async connect() {},
    async disconnect() {},
    async getChatMode() { return 'group'; },
    getConnectionStatus() { return { state: 'connected', reconnectAttempts: 0 }; },
    async createCard(card) {
      createdCards.push(card);
      const cardId = 'card_process';
      cardById.set(cardId, card);
      return { cardId };
    },
    async updateCardById(cardId, card, sequence) {
      updateAttempts.push({ cardId, card, sequence });
      if (updateAttempts.length <= 3) throw new Error('transient CardKit outage');
      cardById.set(cardId, card);
    },
    async updateCard() {},
    async send(chatId, content, options) {
      const cardId = (content as { cardId?: unknown } | undefined)?.cardId;
      const resolvedContent = typeof cardId === 'string' && cardById.has(cardId)
        ? { card: cardById.get(cardId) }
        : content;
      const result = { chatId, content: resolvedContent, options, messageId: `sent_${nextMessage++}` };
      sent.push(result);
      return { messageId: result.messageId };
    },
    async stream(_chatId, input) {
      streamCalls.push(input);
      const markdown = (input as {
        markdown?: (ctrl: { setContent(content: string): Promise<void> }) => Promise<void>;
      }).markdown;
      await markdown?.({ setContent: vi.fn(async () => {}) });
      return { messageId: 'om_stream' };
    },
    async recallMessage(messageId) { recalledMessageIds.push(messageId); },
    async addReaction(messageId, emojiType) {
      const result = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId }, data: { reaction_type: { emoji_type: emojiType } },
      });
      return (result as { data?: { reaction_id?: string } }).data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}
