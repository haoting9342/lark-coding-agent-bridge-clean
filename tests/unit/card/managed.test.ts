import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendManagedCard, updateManagedCard } from '../../../src/card/managed.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('managed card sending', () => {
  it('falls back to sending the raw card when the card_id message is rejected', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_1' })),
      send: vi.fn()
        .mockRejectedValueOnce(new Error('cardid is invalid'))
        .mockResolvedValueOnce({ messageId: 'om_raw' }),
    };

    const result = await sendManagedCard(
      channel as never,
      'oc_chat',
      { type: 'template', data: { template_id: 'tpl' } },
      { replyTo: 'om_parent', replyInThread: true },
    );

    expect(result).toEqual({ messageId: 'om_raw', cardId: 'card_1' });
    expect(channel.send).toHaveBeenNthCalledWith(
      1,
      'oc_chat',
      { cardId: 'card_1' },
      { replyTo: 'om_parent', replyInThread: true },
    );
    expect(channel.send).toHaveBeenNthCalledWith(
      2,
      'oc_chat',
      { card: { type: 'template', data: { template_id: 'tpl' } } },
      { replyTo: 'om_parent', replyInThread: true },
    );
  });

  it('updates card-id managed messages by card id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_normal' })),
      send: vi.fn(async () => ({ messageId: 'om_normal' })),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_normal', { body: 'cancelled' });

    expect(channel.updateCardById).toHaveBeenCalledWith('card_normal', { body: 'cancelled' }, 1);
    expect(channel.updateCard).not.toHaveBeenCalled();
  });

  it('retries a card-id update twice and preserves its sequence before recovering', async () => {
    vi.useFakeTimers();
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_retry' })),
      send: vi.fn(async () => ({ messageId: 'om_retry' })),
      updateCardById: vi.fn()
        .mockRejectedValueOnce(new Error('temporary failure 1'))
        .mockRejectedValueOnce(new Error('temporary failure 2'))
        .mockResolvedValueOnce(undefined),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    const update = updateManagedCard(channel as never, 'om_retry', { body: 'progress' })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await update).toBeUndefined();

    expect(channel.updateCardById).toHaveBeenCalledTimes(3);
    expect(channel.updateCardById.mock.calls).toEqual([
      ['card_retry', { body: 'progress' }, 1],
      ['card_retry', { body: 'progress' }, 1],
      ['card_retry', { body: 'progress' }, 1],
    ]);
  });

  it('rejects after three card-id update attempts with the same sequence', async () => {
    vi.useFakeTimers();
    const finalError = new Error('persistent failure');
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_exhausted' })),
      send: vi.fn(async () => ({ messageId: 'om_exhausted' })),
      updateCardById: vi.fn(async () => {
        throw finalError;
      }),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    const update = updateManagedCard(channel as never, 'om_exhausted', { body: 'progress' })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await update).toBe(finalError);

    expect(channel.updateCardById).toHaveBeenCalledTimes(3);
    expect(channel.updateCardById.mock.calls).toEqual([
      ['card_exhausted', { body: 'progress' }, 1],
      ['card_exhausted', { body: 'progress' }, 1],
      ['card_exhausted', { body: 'progress' }, 1],
    ]);
  });

  it('updates raw-card fallback messages by message id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_raw' })),
      send: vi.fn()
        .mockRejectedValueOnce(new Error('cardid is invalid'))
        .mockResolvedValueOnce({ messageId: 'om_raw_update' }),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_raw_update', { body: 'cancelled' });

    expect(channel.updateCard).toHaveBeenCalledWith('om_raw_update', { body: 'cancelled' });
    expect(channel.updateCardById).not.toHaveBeenCalled();
  });
});
