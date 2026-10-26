import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateSecret, normalizeCallbackUrl, isPublicAddress, validateCallbackUrl, signHeaders, verifyCallback, sendEvent } from '../lib/webhook.mjs';

const secret = byte => 'whsec_' + Buffer.alloc(32, byte).toString('base64');
const subscription = { id: 'sub_abc', url: 'https://receiver.example/callback?opaque=1', secret: secret(1) };
const lookup = async () => [{ address: '1.1.1.1', family: 4 }];
const event = { eventId: 'evt_stable', name: 'glasses.message.created', timestamp: '2026-10-21T00:00:00Z', data: { task_id: 'QG-test', channel: 'n1pro' }, cursor: null };

test('Standard Webhooks signatures cover the exact bytes, ID and Unix seconds with bounded secret rotation', () => {
  const body = Buffer.from(JSON.stringify({ text: '中文换行\n引号"' })), now = 1800000000123;
  const headers = signHeaders(subscription, event.eventId, body, now);
  const expected = createHmac('sha256', Buffer.alloc(32, 1)).update('evt_stable.1800000000.').update(body).digest('base64');
  assert.equal(headers['webhook-signature'], 'v1,' + expected);
  assert.equal(headers['webhook-id'], event.eventId);
  assert.equal(headers['webhook-timestamp'], '1800000000');
  assert.equal(headers['X-MCP-Subscription-Id'], subscription.id);
  const rotating = { ...subscription, previousSecret: secret(2), previousSecretExpiresAt: now + 60000 };
  assert.equal(signHeaders(rotating, event.eventId, body, now)['webhook-signature'].split(' ').length, 2);
  assert.equal(signHeaders(rotating, event.eventId, body, now + 60000)['webhook-signature'].split(' ').length, 1);
  for (const size of [24, 64]) assert.equal(validateSecret('whsec_' + Buffer.alloc(size).toString('base64')).length, size);
  for (const invalid of ['abc', 'whsec_!!!!', 'whsec_a', 'whsec_' + Buffer.alloc(23).toString('base64'), 'whsec_' + Buffer.alloc(65).toString('base64')]) assert.throws(() => validateSecret(invalid), { reason: 'invalid_secret' });
});

test('private, local, metadata, documentation, mapped and transition addresses are blocked', async () => {
  for (const address of ['0.0.0.0','10.2.3.4','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.0.1','192.0.2.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','168.63.129.16','::','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','ff02::1','64:ff9b::a00:1','2001:db8::1','2001::1','2002:7f00:1::','3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['http://receiver.example/','https://user:pass@receiver.example/','https://receiver.example/#fragment','https://localhost/','https://sub.localhost/','https://metadata.google.internal/','https://receiver.local/','https://127.1/','https://2130706433/','https://[::1]/']) await assert.rejects(() => validateCallbackUrl(url, { lookup }), error => ['invalid_url','non_public_address'].includes(error.reason));
  await assert.rejects(() => validateCallbackUrl(subscription.url, { lookup: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] }), { reason: 'non_public_address' });
  await assert.rejects(() => validateCallbackUrl(subscription.url, { lookup: async () => [] }), { reason: 'non_public_address' });
  await assert.rejects(() => validateCallbackUrl(subscription.url, { lookup: async () => { throw Error('sensitive DNS detail'); } }), { reason: 'dns_failed' });
  assert.equal(normalizeCallbackUrl('https://receiver.example:443/callback'), 'https://receiver.example/callback');
});

test('callback verification signs a fresh challenge and checks the response before activation', async () => {
  const seen = [];
  const request = async (options, body) => {
    const parsed = JSON.parse(body.toString('utf8'));
    assert.equal(parsed.type, 'verification');
    assert.equal(options.pinnedAddress, '1.1.1.1');
    assert.equal(options.hostname, 'receiver.example');
    assert.equal(options.servername, 'receiver.example');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.redirect, 'error');
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxBytes, 262144);
    assert.equal(options.headers['X-MCP-Subscription-Id'], subscription.id);
    assert.equal(options.headers['User-Agent'],'DotsBridge-Webhook/0.1.0');
    assert.equal(options.headers.Accept,'application/json');
    seen.push({ challenge: parsed.challenge, id: options.headers['webhook-id'] });
    return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
  };
  assert.equal((await verifyCallback(subscription, { lookup, request })).verified, true);
  await verifyCallback(subscription, { lookup, request });
  assert.notEqual(seen[0].challenge, seen[1].challenge);
  assert.notEqual(seen[0].id, seen[1].id);
  await assert.rejects(() => verifyCallback(subscription, { lookup, request: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) }), { reason: 'challenge_failed' });
  await assert.rejects(() => verifyCallback(subscription, { lookup, request: async (_options, body) => ({ status: 400, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }) }), { reason: 'challenge_failed' });
});

test('every delivery revalidates DNS and pins one public IP without following redirects', async () => {
  let resolveCount = 0, requests = 0;
  const changing = async () => [{ address: ++resolveCount === 1 ? '1.1.1.1' : '127.0.0.1', family: 4 }];
  const request = async (options, body) => {
    requests++;
    assert.equal(options.pinnedAddress, '1.1.1.1');
    assert.equal(options.path, '/callback?opaque=1');
    assert.deepEqual(JSON.parse(body), event);
    assert.equal(options.headers['webhook-id'], event.eventId);
    return { status: 202, body: '' };
  };
  assert.deepEqual(await sendEvent(subscription, event, { lookup: changing, request }), { accepted: true, status: 202 });
  await assert.rejects(() => sendEvent(subscription, event, { lookup: changing, request }), { reason: 'non_public_address' });
  assert.equal(requests, 1);
  await assert.rejects(() => sendEvent(subscription, event, { lookup, request: async () => ({ status: 302, body: '' }) }), { reason: 'redirect' });
  assert.deepEqual(await sendEvent(subscription, event, { lookup, request: async () => ({ status: 413, body: '' }) }), { accepted: false, status: 413 });
});

test('verification failure diagnostics retain status and response shape, never callback URL or body',async()=>{
  for(const body of ['private-body-secret-not-json',JSON.stringify({error:'private-secret'})]){
    await assert.rejects(()=>verifyCallback(subscription,{lookup,request:async()=>({status:403,body})}),error=>{
      assert.equal(error.reason,'challenge_failed');assert.equal(error.diagnostics.httpStatus,403);
      assert.equal(error.diagnostics.responseBytes,Buffer.byteLength(body));assert.equal(error.diagnostics.hasChallenge,false);
      assert.doesNotMatch(JSON.stringify(error.diagnostics),/private|secret|opaque|https:/);return true;
    });
  }
  await assert.rejects(()=>verifyCallback(subscription,{lookup,request:async()=>({status:403,headers:{'content-type':'text/html',server:'cloudflare'},body:'<!doctype html><title>Just a moment</title><p>cf-chl-private-value</p>'})}),error=>{
    assert.equal(error.diagnostics.htmlResponse,true);assert.equal(error.diagnostics.cloudflareResponse,true);assert.equal(error.diagnostics.browserChallenge,true);
    assert.doesNotMatch(JSON.stringify(error.diagnostics),/private-value|doctype|title/);return true;
  });
});

test('request/response payload budgets fail safely without exposing callback details or errors', async () => {
  let requests = 0;
  const request = async () => { requests++; return { status: 200, body: '' }; };
  await assert.rejects(() => sendEvent(subscription, { ...event, data: { text: 'a'.repeat(262145) } }, { lookup, request }), { reason: 'payload_too_large' });
  assert.equal(requests, 0);
  await assert.rejects(() => sendEvent(subscription, event, { lookup, request: async () => ({ status: 200, body: Buffer.alloc(262145) }) }), { reason: 'response_too_large' });
  await assert.rejects(() => sendEvent(subscription, event, { lookup, request: async () => { throw Error('opaque=1 and secret payload must stay private'); } }), error => {
    assert.equal(error.reason, 'network_error');
    assert.ok(!error.message.includes('opaque'));
    assert.ok(!error.message.includes('secret payload'));
    return true;
  });
});

test('a DNS answer arriving after the absolute deadline cannot trigger a late outbound request', async () => {
  let finishLookup, requests = 0;
  const waiting = new Promise(resolve => { finishLookup = resolve; });
  await assert.rejects(() => sendEvent(subscription, event, { lookup: () => waiting, request: async () => { requests++; return { status: 200, body: '' }; } }), { reason: 'timeout' });
  finishLookup([{ address: '1.1.1.1', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});
