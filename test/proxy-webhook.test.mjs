import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProxyRequest, createProxyWebhookTransport } from '../lib/proxy-webhook.mjs';

const PROXY = 'http://fixture_user:fixture_password_123456789@127.0.0.1:17327';
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const subscription = { id: 'sub_proxy_fixture', url: 'https://receiver.example:8443/callback?opaque=private', secret };
const event = { eventId: 'evt_proxy_fixture', name: 'glasses.message.created', data: { task_id: 'QG-proxy', channel: 'n1pro' } };
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
const options = extra => ({ hostname: 'receiver.example', pinnedAddress: '8.8.8.8', family: 4, port: 8443, path: '/callback?opaque=private', rejectUnauthorized: true, timeout: 10000, maxBytes: 262144, headers: { 'webhook-signature': 'signed-fixture' }, ...extra });

function fixture({ status = 200, responseBody = '', callback, error, never = false } = {}) {
  const seen = [], agents = [], requests = [], responses = [];
  class Agent {
    constructor(url, settings) { this.url = url; this.settings = settings; this.destroyed = false; agents.push(this); }
    destroy() { this.destroyed = true; }
  }
  const httpsRequest = (opts, onResponse) => {
    seen.push(opts);
    const request = new EventEmitter();
    request.destroy = () => { request.destroyed = true; };
    request.setTimeout = (ms, fn) => { request.timeout = ms; request.onTimeout = fn; };
    request.end = body => {
      request.body = body;
      if (never) return;
      queueMicrotask(() => {
        if (error) { request.emit('error', Error(error)); return; }
        const response = new PassThrough();
        response.statusCode = status; response.headers = { 'content-type': 'application/json' };
        responses.push(response); onResponse(response);
        if (callback) callback(response, body);
        else response.end(responseBody);
      });
    };
    requests.push(request); return request;
  };
  return { Agent, httpsRequest, seen, agents, requests, responses, lookup };
}

test('proxy configuration admits only the fixed authenticated loopback listener', () => {
  for (const bad of [undefined, '', 'http://127.0.0.1:17327', PROXY.replace('http:', 'https:'), PROXY.replace('127.0.0.1', 'localhost'), PROXY.replace('127.0.0.1', '127.1'), PROXY.replace('17327', '17328'), PROXY + '/path', PROXY + '?x=1', PROXY + '#fragment', PROXY.replace('127.0.0.1', '8.8.8.8'), PROXY.replace('fixture_password_123456789', 'short'), PROXY.replace('fixture_user', 'name%0D%0AHeader')]) {
    assert.throws(() => createProxyRequest(bad), error => error.reason === 'invalid_proxy_configuration' && !error.message.includes('fixture_password'));
  }
  assert.equal(typeof createProxyRequest(PROXY), 'function');
});

test('CONNECT authority pins the checked IP while TLS identity and HTTP Host retain original domain and port', async () => {
  const f = fixture({ status: 202 });
  const signal = new AbortController();
  const request = createProxyRequest(PROXY, f);
  const result = await request(options({ signal: signal.signal, headers: { 'webhook-signature': 'signed-fixture', Host: 'wrong', 'Proxy-Authorization': 'must-not-forward' } }), Buffer.from('private-body'));
  assert.equal(result.status, 202);
  const sent = f.seen[0], agent = f.agents[0];
  assert.equal(sent.hostname, '8.8.8.8'); assert.equal(sent.port, 8443);
  assert.equal(sent.path, '/callback?opaque=private');
  assert.equal(sent.servername, 'receiver.example'); assert.equal(sent.rejectUnauthorized, true);
  assert.equal(sent.headers.Host, 'receiver.example:8443');
  assert.equal(sent.headers['webhook-signature'], 'signed-fixture');
  assert.equal(sent.headers['Proxy-Authorization'], undefined);
  assert.equal(sent.headers['Content-Length'], 12);
  assert.equal(sent.timeout, 10000); assert.equal(f.requests[0].timeout, 10000);
  assert.equal(agent.url, 'http://127.0.0.1:17327');
  assert.equal(agent.settings.headers()['Proxy-Authorization'], 'Basic ' + Buffer.from('fixture_user:fixture_password_123456789').toString('base64'));
  assert.equal(agent.settings.signal, sent.signal);
  assert.equal(agent.destroyed, true); assert.equal(f.requests[0].destroyed, true);
  await request(options({ port: 443 }), Buffer.from('next'));
  assert.equal(f.seen[1].headers.Host, 'receiver.example');
  assert.notEqual(f.agents[0], f.agents[1]);
  assert.ok(f.agents.every(a => a.destroyed));
});

test('IPv6 pins and original IPv6 Host use their correct authorities without disabling TLS validation', async () => {
  const f = fixture();
  await createProxyRequest(PROXY, f)(options({ hostname: '2606:4700:4700::1111', pinnedAddress: '2606:4700:4700::1111', family: 6 }), Buffer.from('x'));
  assert.equal(f.seen[0].hostname, '2606:4700:4700::1111');
  assert.equal(f.seen[0].headers.Host, '[2606:4700:4700::1111]:8443');
  assert.equal(f.seen[0].servername, undefined);
  assert.equal(f.seen[0].rejectUnauthorized, true);
});

test('upper webhook validation, signatures, verification echo, HTTP failures and redirects remain effective', async () => {
  const f = fixture({ callback: (response, body) => response.end(JSON.stringify({ challenge: JSON.parse(body).challenge })) });
  const transport = createProxyWebhookTransport(PROXY, f);
  assert.deepEqual(await transport.verifyCallback(subscription), { verified: true, status: 200 });
  assert.ok(f.seen[0].headers['webhook-signature'].startsWith('v1,'));
  assert.equal(f.seen[0].headers['X-MCP-Subscription-Id'], subscription.id);
  assert.deepEqual(await createProxyWebhookTransport(PROXY, fixture({ status: 413 })).sendEvent(subscription, event), { accepted: false, status: 413 });
  await assert.rejects(() => createProxyWebhookTransport(PROXY, fixture({ status: 302 })).sendEvent(subscription, event), { reason: 'redirect' });
  const blocked = fixture(); blocked.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(() => createProxyWebhookTransport(PROXY, blocked).sendEvent(subscription, event), { reason: 'non_public_address' });
  assert.equal(blocked.requests.length, 0);
});

test('response oversize destroys this response, request and agent before returning safe failure', async () => {
  const f = fixture({ responseBody: Buffer.alloc(33) });
  await assert.rejects(() => createProxyRequest(PROXY, f)(options({ maxBytes: 32 }), Buffer.from('x')), { reason: 'response_too_large' });
  assert.equal(f.requests[0].destroyed, true); assert.equal(f.responses[0].destroyed, true); assert.equal(f.agents[0].destroyed, true);
});

test('absolute deadline and caller abort close pending CONNECT, with no late outbound follow-up', async () => {
  const deadline = fixture({ never: true });
  const start = Date.now();
  await assert.rejects(() => createProxyRequest(PROXY, deadline)(options({ timeout: 25 }), Buffer.from('x')), { reason: 'timeout' });
  assert.ok(Date.now() - start < 1500); assert.equal(deadline.agents[0].settings.signal.aborted, true);
  assert.equal(deadline.agents[0].destroyed, true);
  const f = fixture({ never: true }), controller = new AbortController();
  const pending = createProxyRequest(PROXY, f)(options({ signal: controller.signal }), Buffer.from('x'));
  controller.abort();
  await assert.rejects(() => pending, { reason: 'timeout' });
  assert.equal(f.seen[0].signal.aborted, true);
  assert.equal(f.requests[0].destroyed, true);
});

test('network and constructor errors never expose proxy credentials, callback URL or signed body', async () => {
  const leaked = 'fixture_password_123456789 https://receiver.example?opaque=private private-body';
  const f = fixture({ error: leaked });
  await assert.rejects(() => createProxyRequest(PROXY, f)(options(), Buffer.from('private-body')), error => {
    assert.equal(error.reason, 'network_error'); assert.doesNotMatch(JSON.stringify(error), /fixture_password|receiver|private/); return true;
  });
  await assert.rejects(() => createProxyRequest(PROXY, { Agent: class { constructor() { throw Error(leaked); } } })(options(), Buffer.from('x')), { reason: 'network_error' });
  for (const invalid of [{ pinnedAddress: '127.0.0.1' }, { family: 6 }, { rejectUnauthorized: false }, { timeout: 10001 }, { path: '/bad\r\n' }]) await assert.rejects(() => createProxyRequest(PROXY, f)(options(invalid), Buffer.from('x')), { reason: 'invalid_request' });
});

test('real loopback HTTP CONNECT tunnels pinned public IPv4 and IPv6 authorities to a trusted synthetic TLS receiver', async t => {
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : '/usr/bin/openssl';
  if (!existsSync(openssl)) { t.skip('Existing OpenSSL is not available'); return; }
  const root = resolve('test/.proxy-webhook-temp'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=receiver.example', '-addext', 'subjectAltName=DNS:receiver.example'], { stdio: 'ignore', timeout: 15000 });
  const cert = readFileSync(certPath), connects = [], hostHeaders = [], servernames = [], sockets = new Set();
  let stallConnect = false, stalledSocket;
  const receiver = https.createServer({ key: readFileSync(keyPath), cert }, (req, res) => {
    hostHeaders.push(req.headers.host); servernames.push(req.socket.servername); let body = '';
    req.on('data', c => body += c); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ challenge: JSON.parse(body).challenge })); });
  });
  await new Promise((done, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', done); });
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  const proxy = http.createServer();
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    connects.push({ authority: req.url, authorization: req.headers['proxy-authorization'] });
    if (stallConnect) { stalledSocket = client; client.on('end', () => client.end()); client.resume(); return; }
    const upstream = net.connect(receiver.address().port, '127.0.0.1'); track(upstream);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  });
  t.after(async () => { for (const s of sockets) s.destroy(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => receiver.close(r))]); });
  try { await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(17327, '127.0.0.1', done); }); }
  catch (error) { if (error.code === 'EADDRINUSE') { t.skip('Approved local proxy port already in use; no existing listener changed'); return; } throw error; }
  const trustedRequest = (opts, callback) => https.request({ ...opts, ca: cert }, callback);
  for (const [address, family] of [['8.8.8.8', 4], ['2606:4700:4700::1111', 6]]) {
    const transport = createProxyWebhookTransport(PROXY, { lookup: async () => [{ address, family }], httpsRequest: trustedRequest });
    assert.deepEqual(await transport.verifyCallback(subscription), { verified: true, status: 200 });
  }
  assert.deepEqual(connects.map(x => x.authority), ['8.8.8.8:8443', '[2606:4700:4700::1111]:8443']);
  assert.ok(connects.every(x => x.authorization === 'Basic ' + Buffer.from('fixture_user:fixture_password_123456789').toString('base64')));
  assert.deepEqual(hostHeaders, ['receiver.example:8443', 'receiver.example:8443']);
  assert.deepEqual(servernames, ['receiver.example', 'receiver.example']);
  await assert.rejects(() => createProxyWebhookTransport(PROXY, { lookup }).verifyCallback(subscription), { reason: 'network_error' });
  await assert.rejects(() => createProxyWebhookTransport(PROXY, { lookup, httpsRequest: trustedRequest }).verifyCallback({ ...subscription, url: 'https://wrong-identity.example:8443/callback' }), { reason: 'network_error' });
  // Agent.destroy alone does not cover an unassigned CONNECT socket. The
  // constructor signal must close a stalled proxy handshake at the deadline.
  stallConnect = true;
  await assert.rejects(() => createProxyRequest(PROXY, { httpsRequest: trustedRequest })(options({ timeout: 75 }), Buffer.from('x')), { reason: 'timeout' });
  assert.ok(stalledSocket);
  if (!stalledSocket.destroyed) await Promise.race([
    new Promise(done => stalledSocket.once('close', done)),
    new Promise((_, reject) => setTimeout(() => reject(Error('Pending CONNECT socket survived deadline')), 500))
  ]);
  assert.equal(stalledSocket.destroyed, true);
});
