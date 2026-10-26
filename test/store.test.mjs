import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { EventStore, LIMITS, subscriptionId } from '../lib/store.mjs';

const secret = byte => 'whsec_' + Buffer.alloc(32, byte).toString('base64');
const input = (extra = {}) => ({ owner: 'owner', name: 'glasses.message.created', arguments: { channel: 'n1pro' }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: secret(1) }, ...extra });
function fixture(t) {
  const parent = resolve(process.env.BRIDGE_TEST_DIR || join('work', 'dot-event-tests'));
  assert.ok(parent.toLowerCase().split(sep).includes('work'));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'store-'));
  let time = 1800000000000;
  t.after(() => { assert.ok(dir.startsWith(parent + sep)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store: new EventStore(dir, { now: () => time }), advance: ms => time += ms, now: () => time };
}
const media = (extra = {}) => ({ id: 'media_first', kind: 'image', mimeType: 'image/jpeg', size: 1024, sha256: 'a'.repeat(64), fileName: '眼镜照片.jpg', expiresAt: 1800086400000, ...extra });

test('WeChat unavailable attachments persist an explicit warning without pretending an image exists', t => {
  const { store, dir, now } = fixture(t), message = '  ' + '原'.repeat(11996) + '\n ';
  const input = { message, requestId: 'failed-attachment', channel: 'weixin', inputError: 'unavailable_attachment' };
  const task = store.enqueue(input);
  assert.equal(task.message.length, 12000); assert.equal(task.message, message);
  assert.match(task.inputWarning, /未能取得可识别的原图/); assert.equal(task.images, undefined);
  const reopened = new EventStore(dir, { now });
  assert.equal(reopened.read().tasks[0].inputError, 'unavailable_attachment');
  assert.equal(reopened.readTask(task.id, 'owner', 'weixin').inputWarning, task.inputWarning);
  assert.equal(reopened.enqueue(input).deduplicated, true); assert.equal(reopened.read().events.length, 1);
  assert.throws(() => reopened.enqueue({ ...input, message: message.slice(1) }), { status: 409 });
  assert.throws(() => reopened.enqueue({ ...input, inputError: '' }), { status: 409 });
  for (const invalid of [{ ...input, inputError: 'raw_private_error' }, { ...input, channel: 'n1pro' }, { ...input, images: [media()] }]) assert.throws(() => reopened.enqueue(invalid), { status: 400 });
});

test('only an exact same-owner WeChat photo retry can fall back to an attachment error without changing committed data', t => {
  const { store } = fixture(t), input = { message: ' 原话\n', requestId: 'committed-photo', channel: 'weixin', sourceFingerprint: 'b'.repeat(64), images: [media()] };
  const first = store.enqueue(input), before = readFileSync(store.path);
  const fallback = { message: input.message, requestId: input.requestId, channel: 'weixin', inputError: 'unavailable_attachment' };
  assert.equal(store.requestMatches(fallback).id, first.id);
  const duplicate = store.enqueue(fallback); assert.equal(duplicate.id, first.id); assert.equal(duplicate.deduplicated, true);
  assert.deepEqual(duplicate.images, first.images); assert.equal(duplicate.inputWarning, undefined); assert.deepEqual(readFileSync(store.path), before);
  assert.throws(() => store.enqueue({ ...fallback, message: '不同原话' }), { status: 409 });
  const other = store.enqueue({ ...fallback, owner: 'other' }); assert.notEqual(other.id, first.id); assert.equal(other.images, undefined);
  const glasses = store.enqueue({ message: '旧眼镜照片', requestId: 'cross-channel', images: [media()] });
  assert.throws(() => store.enqueue({ ...fallback, message: glasses.message, requestId: 'cross-channel' }), { status: 409 });
  store.enqueue({ message: '纯文字', channel: 'weixin', requestId: 'text-only' });
  assert.throws(() => store.enqueue({ ...fallback, message: '纯文字', requestId: 'text-only' }), { status: 409 });
});

test('enqueue is owner-scoped and idempotent, and events carry only an opaque task reference', t => {
  const { store } = fixture(t);
  const sub = store.upsertSubscription(input());
  const task = store.enqueue({ message: '帮我处理中文任务\n用户原话', requestId: 'request-1' });
  assert.equal(task.state, 'queued');
  assert.equal(store.enqueue({ message: task.message, requestId: 'request-1' }).id, task.id);
  assert.throws(() => store.enqueue({ message: '另一件事', requestId: 'request-1' }), { status: 409 });
  const another = store.enqueue({ message: task.message, requestId: 'request-1', owner: 'other' });
  assert.notEqual(another.id, task.id);
  const due = store.outgoingDeliveries();
  assert.equal(due.length, 1);
  assert.equal(due[0].subscription.id, sub.id);
  assert.deepEqual(due[0].event.data, { task_id: task.id, channel: 'n1pro' });
  assert.equal(due[0].event.name, 'glasses.message.created');
  assert.equal(due[0].event.cursor, null);
  assert.ok(!JSON.stringify(due[0].event).includes(task.message));
  assert.equal(Object.prototype.hasOwnProperty.call(due[0].event, 'owner'), false);
  assert.throws(() => store.view(task.id, 'other'), { status: 404 });
});

test('webhook acceptance is notified only and never fabricates a reply or downgrades processing/replied', t => {
  const { store } = fixture(t);
  store.upsertSubscription(input());
  const task = store.enqueue({ message: '检查进度' }), job = store.outgoingDeliveries()[0];
  store.recordDelivery(job.event.eventId, job.subscription.id, { status: 202, accepted: true });
  assert.equal(store.view(task.id).state, 'notified');
  assert.equal(store.view(task.id).reply, null);
  assert.equal(store.outgoingDeliveries().length, 0);
  assert.equal(store.readTask(task.id).state, 'processing');
  const reply = store.submitReply({ taskId: task.id, replyId: 'reply-1', text: '已核对，尚待人工验收' });
  assert.equal(reply.state, 'replied');
  assert.equal(store.submitReply({ taskId: task.id, replyId: 'reply-1', text: reply.reply }).deduplicated, true);
  assert.throws(() => store.submitReply({ taskId: task.id, replyId: 'reply-1', text: '不同内容' }), { status: 409 });
  assert.throws(() => store.submitReply({ taskId: task.id, replyId: 'reply-1', text: reply.reply, owner: 'other' }), { status: 404 });
  store.recordDelivery(job.event.eventId, job.subscription.id, { status: 500, accepted: false });
  assert.equal(store.readTask(task.id).state, 'replied');
  assert.deepEqual(store.listNotifications(), []);
});

test('unread tasks include queued and accepted notifications, preserve owner and channel, and leave after read', t => {
  const { store, dir, now, advance } = fixture(t);
  for (const channel of ['n1pro', 'weixin']) {
    store.upsertSubscription(input({ name: channel === 'weixin' ? 'bridge.message.created' : 'glasses.message.created', arguments: { channel } }));
    const queued = store.enqueue({ message: '尚未通知', channel }); advance(1);
    const notified = store.enqueue({ message: '平台已接收，但助手尚未读取', channel }); advance(1);
    const delivery = store.outgoingDeliveries().find(row => row.event.data.task_id === notified.id);
    store.recordDelivery(delivery.event.eventId, delivery.subscription.id, { status: 200, accepted: true });
    const processing = store.enqueue({ message: '已读取', channel }); store.readTask(processing.id, 'owner', channel); advance(1);
    const replied = store.enqueue({ message: '已有回复', channel }); store.submitReply({ taskId: replied.id, replyId: 'done-' + channel, text: '已完成' });
    const otherOwner = store.enqueue({ message: '其他用户的未读任务', channel, owner: 'other' });
    const before = readFileSync(store.path);
    const expected = { tasks: [{ id: queued.id, state: 'queued', createdAt: queued.createdAt }, { id: notified.id, state: 'notified', createdAt: notified.createdAt }], truncated: false };
    assert.deepEqual(store.pendingMessages('owner', channel), expected);
    assert.deepEqual(readFileSync(store.path), before);
    const reopened = new EventStore(dir, { now });
    assert.deepEqual(reopened.pendingMessages('owner', channel), expected);
    assert.deepEqual(reopened.pendingMessages('other', channel).tasks.map(task => task.id), [otherOwner.id]);
    reopened.readTask(notified.id, 'owner', channel);
    assert.deepEqual(reopened.pendingMessages('owner', channel).tasks.map(task => task.id), [queued.id]);
    reopened.readTask(queued.id, 'owner', channel);
    assert.deepEqual(reopened.pendingMessages('owner', channel), { tasks: [], truncated: false });
    assert.equal(reopened.view(processing.id).state, 'processing'); assert.equal(reopened.view(replied.id).state, 'replied');
  }
});

test('unread pagination retains the original insertion order and fields across mixed queued and notified states', t => {
  const { store, advance } = fixture(t), expected = [];
  store.upsertSubscription(input({ name: 'bridge.message.created', arguments: { channel: 'weixin' } }));
  const unrelated = store.enqueue({ message: '眼镜任务不应混入微信待办' });
  for (let index = 0; index < 51; index++) {
    const task = store.enqueue({ message: '微信未读任务 ' + index, channel: 'weixin' });
    if (index % 2) {
      const delivery = store.outgoingDeliveries().find(row => row.event.data.task_id === task.id);
      store.recordDelivery(delivery.event.eventId, delivery.subscription.id, { status: 200, accepted: true });
    }
    expected.push({ id: task.id, state: index % 2 ? 'notified' : 'queued', createdAt: task.createdAt }); advance(1);
  }
  assert.deepEqual(store.pendingMessages('owner', 'weixin'), { tasks: expected.slice(0, 50), truncated: true });
  assert.deepEqual(store.pendingMessages().tasks.map(task => task.id), [unrelated.id]);
  store.readTask(expected[0].id, 'owner', 'weixin');
  assert.deepEqual(store.pendingMessages('owner', 'weixin'), { tasks: expected.slice(1), truncated: false });
});

test('proactive notifications stay pending, deduplicate, and enforce owner/task ownership', t => {
  const { store } = fixture(t), task = store.enqueue({ message: '任务' });
  const notice = store.createNotification({ notificationId: 'notice-1', text: 'Dot主动提醒', kind: 'reminder', taskId: task.id });
  assert.equal(notice.state, 'pending');
  assert.equal(store.createNotification({ notificationId: 'notice-1', text: notice.text, kind: 'reminder', taskId: task.id }).id, notice.id);
  assert.equal(store.listNotifications().length, 1);
  assert.deepEqual(store.listNotifications('other'), []);
  assert.throws(() => store.createNotification({ notificationId: 'notice-1', text: '变化', kind: 'reminder', taskId: task.id }), { status: 409 });
  assert.throws(() => store.createNotification({ notificationId: 'notice-2', text: '不能跨用户', taskId: task.id, owner: 'other' }), { status: 404 });
});

test('subscriptions persist, refresh in place, expire, rotate briefly, and unsubscribe idempotently', t => {
  const { store, dir, now, advance } = fixture(t);
  const config = input({ expiresAt: now() + 2000 }), first = store.upsertSubscription(config);
  assert.equal(first.id, subscriptionId(config));
  assert.ok(!JSON.stringify(first).includes(secret(1)));
  const normalized = input({ delivery: { mode: 'webhook', url: 'https://receiver.example:443/callback', secret: secret(2) }, expiresAt: now() + 2000 });
  assert.equal(store.upsertSubscription(normalized).id, first.id);
  const task = store.enqueue({ message: '轮换期间' });
  let job = store.outgoingDeliveries()[0];
  assert.equal(job.subscription.secret, secret(2));
  assert.equal(job.subscription.previousSecret, secret(1));
  const reopened = new EventStore(dir, { now });
  assert.equal(reopened.view(task.id).message, task.message);
  advance(2000);
  assert.deepEqual(reopened.outgoingDeliveries(), []);
  reopened.upsertSubscription({ ...normalized, expiresAt: now() + 120000 });
  advance(60000);
  job = reopened.outgoingDeliveries()[0];
  assert.equal(job.subscription.previousSecret, undefined);
  reopened.removeSubscription(config); reopened.removeSubscription(config);
  assert.deepEqual(store.outgoingDeliveries(), []);
  store.upsertSubscription({ ...normalized, expiresAt: now() + 120000 });
  assert.deepEqual(store.outgoingDeliveries(), []);
});

test('retry event IDs are stable, failures back off finitely, and 410/413 stop immediately', t => {
  const { store, advance } = fixture(t);
  store.upsertSubscription(input());
  const task = store.enqueue({ message: '重试测试' }), original = store.outgoingDeliveries()[0];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = store.recordDelivery(original.event.eventId, original.subscription.id, { status: 503, accepted: false, error: 'network_error' });
    assert.equal(store.view(task.id).state, 'queued');
    if (attempt < 5) {
      assert.equal(store.outgoingDeliveries().length, 0);
      advance([1000, 5000, 30000, 120000][attempt - 1]);
      assert.equal(store.outgoingDeliveries()[0].event.eventId, original.event.eventId);
    } else assert.equal(result.state, 'terminated');
  }
  assert.deepEqual(store.outgoingDeliveries(), []);
  for (const status of [410, 413]) {
    store.enqueue({ message: '不重试' + status });
    const job = store.outgoingDeliveries()[0];
    assert.equal(store.recordDelivery(job.event.eventId, job.subscription.id, { status, accepted: false }).state, 'terminated');
    advance(1000000);
    assert.deepEqual(store.outgoingDeliveries(), []);
  }
});

test('no replay is invented and subscription filters/ownership do not leak events', t => {
  const { store } = fixture(t);
  store.enqueue({ message: '订阅前任务' });
  store.upsertSubscription(input());
  assert.deepEqual(store.outgoingDeliveries(), []);
  assert.throws(() => store.upsertSubscription(input({ name: 'other.created' })));
  assert.throws(() => store.upsertSubscription(input({ arguments: { channel: 'other' } })));
  assert.throws(() => store.upsertSubscription(input({ arguments: { channel: 'n1pro', extra: true } })));
  store.enqueue({ message: '他人的任务', owner: 'other' });
  assert.deepEqual(store.outgoingDeliveries(), []);
  assert.notEqual(subscriptionId(input()), subscriptionId(input({ owner: 'other' })));
});

test('independent instances serialize mutations through atomic private JSON without overwriting old bridge data', t => {
  const { store, dir, now } = fixture(t), other = new EventStore(dir, { now });
  const first = store.enqueue({ message: '实例一' });
  const second = other.enqueue({ message: '实例二' });
  assert.equal(store.view(second.id).message, '实例二');
  assert.equal(other.view(first.id).message, '实例一');
  assert.deepEqual(readdirSync(join(dir, 'event-core')), ['state.json']);
  if (process.platform !== 'win32') assert.equal(statSync(store.path).mode & 0o777, 0o600);
  const old = join(dir, 'old-bridge'); mkdirSync(old);
  writeFileSync(join(old, 'credentials.json'), 'must remain intact', 'utf8');
  assert.throws(() => new EventStore(old), /旧网页桥接/);
  assert.throws(() => new EventStore(join(old, 'nested')), /旧网页桥接/);
  assert.equal(readFileSync(join(old, 'credentials.json'), 'utf8'), 'must remain intact');
  assert.equal(existsSync(join(old, 'event-core')), false);
  writeFileSync(store.path, '{broken', 'utf8');
  assert.throws(() => store.enqueue({ message: '不能覆盖损坏数据' }), { status: 500 });
  assert.equal(readFileSync(store.path, 'utf8'), '{broken');
});

test('storage limits reject extra entries without silently deleting older records', t => {
  const { store } = fixture(t);
  for (let n = 0; n < LIMITS.subscriptions; n++) store.upsertSubscription(input({ delivery: { mode: 'webhook', url: `https://receiver.example/${n}`, secret: secret(1) } }));
  assert.throws(() => store.upsertSubscription(input({ delivery: { mode: 'webhook', url: 'https://receiver.example/overflow', secret: secret(1) } })), { status: 429 });
  for (let n = 0; n < LIMITS.notifications; n++) store.createNotification({ notificationId: 'notice-' + n, text: '保留' + n });
  assert.throws(() => store.createNotification({ notificationId: 'overflow', text: '超限' }), { status: 429 });
  assert.equal(store.listNotifications().length, LIMITS.notifications);
  assert.equal(store.listNotifications()[0].text, '保留0');
});

test('photo tasks retain bounded metadata and original instruction without URLs in state or events', t => {
  const { store } = fixture(t);
  store.upsertSubscription(input());
  const image = media(), task = store.enqueue({ message: '请根据这张照片\n做一张表格', images: [image], requestId: 'photo-1', sourceFingerprint: 'b'.repeat(64) });
  assert.deepEqual(task.images, [image]);
  assert.equal(task.message, '请根据这张照片\n做一张表格');
  assert.equal('sourceFingerprint' in task, false);
  image.fileName = '外部修改.jpg';
  task.images[0].fileName = '返回值修改.jpg';
  assert.equal(store.view(task.id).images[0].fileName, '眼镜照片.jpg');
  assert.deepEqual(store.outgoingDeliveries()[0].event.data, { task_id: task.id, channel: 'n1pro' });
  assert.ok(!JSON.stringify(store.outgoingDeliveries()[0].event).includes('眼镜照片'));
  const storedTasks = JSON.stringify(JSON.parse(readFileSync(store.path, 'utf8')).tasks);
  assert.ok(!storedTasks.includes('https://'));
  assert.ok(!storedTasks.includes('base64'));
  assert.throws(() => store.view(task.id, 'other'), { status: 404 });
});

test('request prechecks avoid duplicate photo work and detect original input conflicts without mutation', t => {
  const { store } = fixture(t), digest = 'b'.repeat(64);
  assert.equal(store.findRequest('missing'), null);
  assert.equal(store.requestMatches({ message: '新照片', requestId: 'photo-1', sourceFingerprint: digest }), null);
  const task = store.enqueue({ message: '新照片', requestId: 'photo-1', images: [media()], sourceFingerprint: digest });
  const before = readFileSync(store.path, 'utf8');
  const found = store.findRequest('photo-1');
  assert.equal(found.task.id, task.id); assert.equal(found.sourceFingerprint, digest);
  assert.equal(store.findRequest('photo-1', 'other'), null);
  const previous = store.requestMatches({ message: '新照片', requestId: 'photo-1', sourceFingerprint: digest });
  assert.equal(previous.id, task.id); assert.equal(previous.deduplicated, true);
  assert.equal('sourceFingerprint' in previous, false);
  assert.equal(store.enqueue({ message: '新照片', requestId: 'photo-1', sourceFingerprint: digest }).id, task.id);
  assert.equal(readFileSync(store.path, 'utf8'), before);
  for (const changes of [{ message: '改原话' }, { sourceFingerprint: 'c'.repeat(64) }, { sourceFingerprint: '' }, { sourceTaskId: task.id }]) {
    assert.throws(() => store.requestMatches({ message: '新照片', requestId: 'photo-1', sourceFingerprint: digest, ...changes }), { status: 409 });
  }
  assert.equal(readFileSync(store.path, 'utf8'), before);
  const direct = store.enqueue({ message: '照片元数据', requestId: 'direct-1', images: [media()] });
  assert.equal(store.enqueue({ message: '照片元数据', requestId: 'direct-1', images: [media({ id: 'media_retry', expiresAt: 1800090000000 })] }).id, direct.id);
  assert.throws(() => store.enqueue({ message: '照片元数据', requestId: 'direct-1', images: [media({ sha256: 'd'.repeat(64) })] }), { status: 409 });
});

test('photo followups reuse only the same owner photo task and persist through restart', t => {
  const { store, dir, now } = fixture(t);
  const source = store.enqueue({ message: '看照片', images: [media()] });
  const followup = store.enqueue({ message: '再提取第二行', sourceTaskId: source.id, requestId: 'follow-1' });
  assert.equal(followup.sourceTaskId, source.id);
  assert.deepEqual(followup.images, source.images);
  assert.equal(store.requestMatches({ message: '再提取第二行', sourceTaskId: source.id, requestId: 'follow-1' }).id, followup.id);
  assert.throws(() => store.enqueue({ message: '越权', sourceTaskId: source.id, owner: 'other' }), { status: 404 });
  assert.throws(() => store.enqueue({ message: '不存在', sourceTaskId: 'missing' }), { status: 404 });
  assert.throws(() => store.enqueue({ message: '不能混用', sourceTaskId: source.id, images: [media()] }), /不能同时提交/);
  const plain = store.enqueue({ message: '纯文字' });
  assert.throws(() => store.enqueue({ message: '没有照片', sourceTaskId: plain.id }), /没有可引用/);
  const reopened = new EventStore(dir, { now });
  assert.deepEqual(reopened.view(followup.id), store.view(followup.id));
  assert.equal('images' in reopened.view(plain.id), false);
  assert.equal('sourceTaskId' in reopened.view(plain.id), false);
});

test('rich replies use content identity for retries and expose a separate speech summary', t => {
  const { store, dir, now } = fixture(t), task = store.enqueue({ message: '图文结果' });
  const files = [media(), media({ id: 'media_doc', kind: 'file', mimeType: 'application/pdf', sha256: 'c'.repeat(64), fileName: '完整表格.pdf' })];
  const args = { taskId: task.id, replyId: 'rich-reply', text: '完整说明和表格', summary: '照片里的表格已整理好，请在手机查看。', files, replyFingerprint: 'd'.repeat(64) };
  assert.equal(store.findReply(task.id, args.replyId), null);
  const result = store.submitReply(args);
  assert.equal(result.reply, args.text); assert.equal(result.replySummary, args.summary);
  assert.deepEqual(result.replyFiles, files);
  assert.equal('replyFingerprint' in result, false);
  const retryFiles = files.map((file, i) => ({ ...file, id: 'media_retry_' + i, expiresAt: file.expiresAt + 1000 }));
  assert.equal(store.submitReply({ ...args, files: retryFiles }).deduplicated, true);
  assert.deepEqual(store.view(task.id).replyFiles, files);
  const found = store.findReply(task.id, args.replyId);
  assert.equal(found.replyFingerprint, args.replyFingerprint);
  assert.deepEqual(found.files, files);
  for (const changes of [{ text: '改正文' }, { summary: '改播报' }, { replyFingerprint: 'e'.repeat(64) }, { files: [media({ sha256: 'f'.repeat(64) })] }, { files: [media({ fileName: '改名.jpg' }), files[1]] }]) {
    assert.throws(() => store.submitReply({ ...args, ...changes }), { status: 409 });
  }
  assert.throws(() => store.findReply(task.id, args.replyId, 'other'), { status: 404 });
  const another = store.enqueue({ message: '其他任务' });
  assert.throws(() => store.findReply(another.id, args.replyId), { status: 409 });
  assert.throws(() => store.submitReply({ ...args, taskId: another.id }), { status: 409 });
  assert.deepEqual(new EventStore(dir, { now }).findReply(task.id, args.replyId), store.findReply(task.id, args.replyId));
  store.submitReply({ taskId: task.id, replyId: 'plain-reply', text: '最后补充' });
  assert.equal('replyFiles' in store.view(task.id), false);
  assert.equal('replySummary' in store.view(task.id), false);
  assert.deepEqual(store.findReply(task.id, args.replyId).files, files);
});

test('attachment boundaries reject oversized lists, unsafe metadata, and hidden payload fields', t => {
  const { store } = fixture(t), task = store.enqueue({ message: '边界' });
  const invalid = [
    [media(), media({ id: 'media_second' })],
    [media({ id: '../escape' })],
    [media({ kind: 'file', mimeType: 'application/pdf' })],
    [media({ mimeType: 'text/html' })],
    [media({ size: 0 })],
    [media({ sha256: '' })],
    [media({ expiresAt: null })],
    [media({ fileName: '../photo.jpg' })],
    [media({ download_url: 'https://private.example/secret' })],
    [media({ base64: 'not permitted' })]
  ];
  for (const images of invalid) assert.throws(() => store.enqueue({ message: '错误照片', images }));
  assert.throws(() => store.enqueue({ message: '错误摘要', sourceFingerprint: 'https://private.example/secret' }));
  assert.throws(() => store.submitReply({ taskId: task.id, replyId: 'too-many', text: '附件', files: Array.from({ length: 4 }, (_, i) => media({ id: 'media_' + i })) }));
  assert.throws(() => store.submitReply({ taskId: task.id, replyId: 'duplicates', text: '附件', files: [media(), media()] }));
  assert.throws(() => store.submitReply({ taskId: task.id, replyId: 'long-summary', text: '正文', summary: '字'.repeat(1201) }));
  assert.throws(() => store.submitReply({ taskId: task.id, replyId: 'empty', text: '' }));
  assert.equal(store.submitReply({ taskId: task.id, replyId: 'file-only', text: '', files: [media()] }).state, 'replied');
  assert.equal(store.read().tasks.length, 1);
});
