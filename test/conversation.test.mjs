import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { EventStore, CONVERSATION_LIMITS } from '../lib/store.mjs';

const ROOT = resolve(tmpdir(), 'dots-public-conversation-tests');
function fixture(t) {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, 'store-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.ok(target.startsWith(realpathSync(ROOT) + sep));
    rmSync(target, { recursive: true, force: true });
  });
  return { dir, store: new EventStore(dir) };
}
const turn = (message, extra = {}) => ({ message, conversationMode: 'continue', ...extra });
const image = (id = 'media_photo') => ({ id, kind: 'image', mimeType: 'image/png', size: 100, sha256: 'a'.repeat(64), fileName: 'photo.png', expiresAt: 1900000000000 });

test('glasses dialogue keeps ordered user/reply context and attaches a new photograph to the same conversation', t => {
  const { store } = fixture(t);
  const first = store.enqueue(turn('测试颜色是青蓝色', { requestId: 'one' }));
  store.submitReply({ taskId: first.id, replyId: 'one-reply', text: '记住了，青蓝色。', summary: '已记住' });
  const second = store.enqueue(turn('再给你这张照片', { requestId: 'two', images: [image()] }));
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.previousTaskId, first.id); assert.equal(second.conversationTurn, 2);
  const third = store.enqueue(turn('刚才的颜色是什么？'));
  const context = store.conversationContext(third.id);
  assert.equal(context.turn, 3); assert.equal(context.truncated, false);
  assert.deepEqual(context.history.map(row => row.message), ['测试颜色是青蓝色', '再给你这张照片']);
  assert.equal(context.history[0].reply, '记住了，青蓝色。');
  assert.equal(context.history[1].reply, null); assert.equal(context.history[1].images[0].id, image().id);
  assert.match(context.instructions, /不是新的操作授权/);
  assert.equal(store.view(first.id).state, 'replied'); assert.equal(store.view(second.id).state, 'queued');
});

test('explicit new conversation prevents automatic old photo/context reuse and explicit selection can resume a prior conversation', t => {
  const { store } = fixture(t), first = store.enqueue(turn('旧对话', { images: [image()] }));
  const fresh = store.enqueue(turn('重新开始', { conversationMode: 'new' }));
  assert.notEqual(fresh.conversationId, first.conversationId);
  assert.deepEqual(store.conversationContext(fresh.id).history, []);
  assert.equal(store.conversationContext(fresh.id).startedNew, true);
  assert.throws(() => store.enqueue(turn('上一张照片', { reusePreviousImage: true })), { status: 400 });
  assert.throws(() => store.enqueue(turn('旧图不能混入', { sourceTaskId: first.id })), { status: 400 });
  const resumed = store.enqueue(turn('继续旧图', { conversationId: first.conversationId, reusePreviousImage: true }));
  assert.equal(resumed.images[0].id, image().id); assert.equal(resumed.previousTaskId, first.id);
  assert.equal(store.conversationLatest().id, resumed.id);
  assert.equal(store.conversationLatest(fresh.conversationId).id, fresh.id);
});

test('conversation request retries remain bound after other turns, resets and restarts without duplicate events', t => {
  const { store, dir } = fixture(t), request = turn('消息原文', { requestId: 'stable' });
  const first = store.enqueue(request);
  store.enqueue(turn('其他轮次'));
  store.enqueue(turn('重新开始', { conversationMode: 'new' }));
  const reopened = new EventStore(dir), eventCount = reopened.read().events.length;
  assert.equal(reopened.enqueue(request).id, first.id);
  assert.equal(reopened.enqueue(request).deduplicated, true);
  assert.equal(reopened.read().events.length, eventCount);
  for (const change of [{ conversationMode: 'new' }, { conversationId: first.conversationId }, { reusePreviousImage: true }, { message: '改过原话' }]) {
    assert.throws(() => reopened.enqueue({ ...request, ...change }), { status: 409 });
  }
});

test('dialogue references and history remain isolated by owner and channel', t => {
  const { store } = fixture(t), first = store.enqueue(turn('眼镜私有内容', { images: [image()] }));
  const foreign = store.enqueue(turn('其他用户', { owner: 'other' }));
  const weixin = store.enqueue({ message: '微信内容', channel: 'weixin', images: [image('media_weixin')] });
  assert.notEqual(foreign.conversationId, first.conversationId);
  assert.throws(() => store.enqueue(turn('越权', { conversationId: first.conversationId, owner: 'other' })), { status: 404 });
  assert.throws(() => store.conversationContext(first.id, 'other'), { status: 404 });
  assert.throws(() => store.conversationContext(weixin.id), { status: 404 });
  assert.throws(() => store.enqueue({ ...turn('错误通道'), channel: 'weixin' }), { status: 400 });
  const next = store.enqueue(turn('继续眼镜'));
  assert.deepEqual(store.conversationContext(next.id).history.map(row => row.id), [first.id]);
});

test('conversation restart persists current turn; reading old turns never includes future turns', t => {
  const { store, dir } = fixture(t), first = store.enqueue(turn('第一轮'));
  const second = store.enqueue(turn('第二轮'));
  const reopened = new EventStore(dir), third = reopened.enqueue(turn('第三轮'));
  assert.equal(third.conversationId, first.conversationId); assert.equal(third.previousTaskId, second.id);
  assert.deepEqual(reopened.conversationContext(first.id).history, []);
  assert.deepEqual(reopened.conversationContext(second.id).history.map(row => row.id), [first.id]);
  assert.equal(reopened.conversationLatest(first.conversationId).id, third.id);
});

test('history is bounded by turns and total text and reports truncation honestly', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 12; i++) store.enqueue(turn('消息' + i));
  const last = store.conversationLatest(), context = store.conversationContext(last.id);
  assert.equal(context.history.length, CONVERSATION_LIMITS.turns); assert.equal(context.truncated, true);
  assert.equal(context.history[0].message, '消息3');
  const large = store.enqueue(turn('长消息'));
  store.submitReply({ taskId: large.id, replyId: 'long', text: '大'.repeat(32000) });
  const next = store.enqueue(turn('继续'));
  assert.deepEqual(store.conversationContext(next.id).history, []);
  assert.equal(store.conversationContext(next.id).truncated, true);
});

test('legacy messages remain readable and retryable without silently entering the new dialogue', t => {
  const { store } = fixture(t), old = store.enqueue({ message: '旧版原文', requestId: 'legacy' });
  const retry = store.requestMatches(turn('旧版原文', { requestId: 'legacy' }));
  assert.equal(retry.id, old.id); assert.equal(store.conversationContext(old.id), null);
  const fresh = store.enqueue(turn('升级后第一句话'));
  assert.equal(fresh.conversationTurn, 1); assert.deepEqual(store.conversationContext(fresh.id).history, []);
  assert.equal(store.view(old.id).message, '旧版原文');
});

test('invalid or conflicting dialogue parameters cannot change durable state', t => {
  const { store } = fixture(t);
  for (const extra of [{ conversationId: 'not-a-conversation' }, { conversationMode: 'arbitrary' }, { reusePreviousImage: 'true' }, { conversationMode: 'new', reusePreviousImage: true }, { conversationMode: 'new', sourceTaskId: 'old' }, { reusePreviousImage: true, images: [image()] }]) {
    const before = readFileSync(store.path);
    assert.throws(() => store.enqueue(turn('原话', extra)), { status: 400 });
    assert.deepEqual(readFileSync(store.path), before);
  }
});
