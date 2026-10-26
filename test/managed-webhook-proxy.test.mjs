import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGED_PROXY_BINARY_SHA256, startManagedWebhookProxy } from '../lib/managed-webhook-proxy.mjs';

// Public vendor binary only. No real proxy URL, auth, SNI or private file is read.
const vendorBinary = readFileSync(fileURLToPath(new URL('../../../work/vendor/hysteria-v2.13.0/hysteria-linux-amd64', import.meta.url)));
const ROOT = resolve('test/managed-proxy-fixture');
const UID = 1234;
const USER = 'synthetic_user_1234', PASSWORD = 'synthetic_password_0123456789';
const PROXY_URL = 'http://' + USER + ':' + PASSWORD + '@127.0.0.1:17327';
const baseConfig = () => ({ server: 'node.example:443', auth: 'synthetic-node-auth-do-not-log', tls: { sni: 'node.example', insecure: false }, http: { listen: '127.0.0.1:17327', username: USER, password: PASSWORD }, lazy: false });

function fixture({ probe, spawnFailure, killMode = 'exit' } = {}) {
  const paths = { runtime: join(ROOT, '.dot-events'), binary: join(ROOT, '.dot-events/proxy/hysteria'), config: join(ROOT, '.dot-events/private/hysteria-client.json'), proxyUrl: join(ROOT, '.dot-events/private/webhook-proxy.txt') };
  const records = new Map(), descriptors = new Map();
  let nextFd = 1, time = 0, probeCount = 0;
  const mutations = [], spawnCalls = [], transportUrls = [], failures = [];
  const record = (path, data, mode, type = 'file') => {
    records.set(path, { data: type === 'file' ? Buffer.from(data) : undefined, uid: type === 'file' || path.startsWith(paths.runtime) ? UID : 0, mode, type, dev: 1, ino: records.size + 1, nlink: 1, mtimeMs: 123, ctimeMs: 456 });
  };
  for (const target of [ROOT, paths.runtime, dirname(paths.binary), dirname(paths.config)]) {
    for (let path = target; ; path = dirname(path)) {
      if (!records.has(path)) record(path, '', path.startsWith(paths.runtime) ? 0o700 : 0o755, 'directory');
      if (dirname(path) === path) break;
    }
  }
  record(paths.binary, vendorBinary, 0o700);
  const writeConfig = config => record(paths.config, JSON.stringify(config), 0o600);
  writeConfig(baseConfig()); record(paths.proxyUrl, PROXY_URL + '\n', 0o600);
  const stats = path => {
    const value = records.get(path); if (!value) throw Error('synthetic private path must never escape');
    return { ...value, size: value.data?.length || 0, isFile: () => value.type === 'file', isDirectory: () => value.type === 'directory', isSymbolicLink: () => value.type === 'symlink' };
  };
  const fs = {
    lstatSync: stats,
    realpathSync: path => records.get(path)?.realpath || path,
    openSync: path => { const fd = nextFd++; descriptors.set(fd, path); return fd; },
    fstatSync: fd => stats(descriptors.get(fd)),
    readSync: (fd, buffer, offset, length, position) => {
      const data = records.get(descriptors.get(fd)).data;
      return data.copy(buffer, offset, position, Math.min(data.length, position + length));
    },
    closeSync: fd => descriptors.delete(fd),
    accessSync: () => {},
  };
  class Child extends EventEmitter {
    constructor() { super(); this.pid = 43210; this.exitCode = null; this.signals = []; }
    finish() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit('exit', 0, null); }
    kill(signal) {
      this.signals.push(signal);
      if (killMode === 'exit' || killMode === 'kill' && signal === 'SIGKILL') queueMicrotask(() => this.finish());
      return true;
    }
  }
  const child = new Child();
  const transport = { verifyCallback: async () => {}, sendEvent: async () => {} };
  const deps = {
    fs, platform: 'linux', getuid: () => UID,
    now: () => time,
    sleep: async ms => { time += ms; await Promise.resolve(); },
    probePort: async budget => { probeCount++; return probe ? probe(probeCount, child, budget) : probeCount > 1; },
    spawn: (...args) => { spawnCalls.push(args); if (spawnFailure) throw Error(spawnFailure); return child; },
    createTransport: url => { transportUrls.push(url); return transport; }
  };
  return { root: ROOT, paths, records, descriptors, writeConfig, mutations, spawnCalls, transportUrls, failures, child, deps, transport, options: { root: ROOT, deps, onFailure: error => failures.push(error) } };
}

test('verified official binary and private POSIX files start only the fixed child and proxy transport', async () => {
  assert.equal(MANAGED_PROXY_BINARY_SHA256, '907ba8c9693edb104b20582681fb7dc15639d5b64a9cbb616a7b539190a86691');
  const f = fixture();
  const managed = await startManagedWebhookProxy(f.options);
  assert.equal(managed.transport, f.transport);
  assert.deepEqual(f.transportUrls, [PROXY_URL]);
  assert.equal(f.spawnCalls.length, 1);
  const [executable, args, settings] = f.spawnCalls[0];
  assert.equal(executable, f.paths.binary);
  assert.deepEqual(args, ['client', '--config', f.paths.config]);
  assert.deepEqual(settings, { cwd: ROOT, stdio: 'ignore', shell: false, detached: false, windowsHide: true });
  assert.equal(f.descriptors.size, 0);
  await managed.stop();
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  assert.deepEqual(f.failures, []);
});

test('wrong binary hash and unsafe POSIX modes, owner, links and escaped paths reject before spawn', async () => {
  const cases = [
    f => { f.records.get(f.paths.binary).data = Buffer.from('wrong binary'); },
    f => { f.records.get(f.paths.config).mode = 0o644; },
    f => { f.records.get(f.paths.config).uid = 0; },
    f => { f.records.get(f.paths.config).nlink = 2; },
    f => { f.records.get(f.paths.proxyUrl).type = 'symlink'; },
    f => { f.records.get(dirname(f.paths.binary)).mode = 0o755; },
    f => { f.records.get(dirname(f.paths.config)).type = 'symlink'; },
    f => { f.records.get(f.paths.config).realpath = resolve('elsewhere-private-file'); },
    f => { f.records.get(f.paths.binary).mode = 0o777; },
    f => { f.records.get(f.paths.config).data = Buffer.alloc(16385); },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    await assert.rejects(() => startManagedWebhookProxy(f.options), error => ['binary_rejected', 'filesystem_rejected'].includes(error.reason));
    assert.equal(f.spawnCalls.length, 0);
    assert.equal(f.descriptors.size, 0);
  }
  for (const options of [{ root: 'relative' }, { deps: { platform: 'win32', getuid: () => UID } }, { deps: { platform: 'linux', getuid: () => 0 } }]) {
    await assert.rejects(() => startManagedWebhookProxy(options), error => ['runtime_rejected', 'filesystem_rejected'].includes(error.reason));
  }
});

test('TLS verification, SNI, exact listener, listener whitelist and matching random BasicAuth are mandatory', async () => {
  const changes = [
    c => { c.tls.insecure = true; },
    c => { delete c.tls.sni; },
    c => { c.tls.sni = 'invalid/name'; },
    c => { c.tls.ca = '/arbitrary/ca'; },
    c => { c.http.listen = '0.0.0.0:17327'; },
    c => { c.http.password = 'different_password_123456789'; },
    c => { c.http.username = ''; },
    c => { c.socks5 = { listen: '0.0.0.0:1080' }; },
    c => { c.tun = { name: 'not-authorized' }; },
    c => { c.lazy = true; },
    c => { c.server = 'hysteria2://embedded-secret@host'; },
  ];
  for (const change of changes) {
    const f = fixture(), config = baseConfig(); change(config); f.writeConfig(config);
    await assert.rejects(() => startManagedWebhookProxy(f.options), { reason: 'configuration_rejected' });
    assert.equal(f.spawnCalls.length, 0);
  }
});

test('occupied or uncertain port never spawns and no foreign process is inspected or terminated', async () => {
  for (const probe of [() => true, () => undefined, () => { throw Error('sensitive raw socket error'); }]) {
    const f = fixture({ probe });
    await assert.rejects(() => startManagedWebhookProxy(f.options), error => ['port_already_in_use', 'port_probe_failed'].includes(error.reason));
    assert.equal(f.spawnCalls.length, 0); assert.deepEqual(f.child.signals, []);
  }
});

test('spawn, early exit, port-probe and transport-construction failures clean only the owned child', async () => {
  const badSpawn = fixture({ spawnFailure: 'raw ' + PROXY_URL });
  await assert.rejects(() => startManagedWebhookProxy(badSpawn.options), { reason: 'start_failed' });
  assert.deepEqual(badSpawn.child.signals, []);
  const earlyExit = fixture({ probe: (count, child) => { if (count > 1) child.finish(); return count > 1; } });
  await assert.rejects(() => startManagedWebhookProxy(earlyExit.options), { reason: 'start_failed' });
  assert.deepEqual(earlyExit.child.signals, []);
  const probeFailure = fixture({ probe: count => { if (count > 1) throw Error('raw ' + PROXY_URL); return false; } });
  await assert.rejects(() => startManagedWebhookProxy(probeFailure.options), { reason: 'start_failed' });
  assert.deepEqual(probeFailure.child.signals, ['SIGTERM']);
  const transportFailure = fixture(); transportFailure.deps.createTransport = () => { throw Error('raw ' + PROXY_URL); };
  await assert.rejects(() => startManagedWebhookProxy(transportFailure.options), { reason: 'start_failed' });
  assert.deepEqual(transportFailure.child.signals, ['SIGTERM']);
});

test('startup deadline is bounded and escalates termination only on its own child object', async () => {
  const f = fixture({ probe: () => false, killMode: 'kill' });
  await assert.rejects(() => startManagedWebhookProxy(f.options), { reason: 'start_timeout' });
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(f.failures, []);
  const stuck = fixture({ probe: () => false, killMode: 'never' });
  await assert.rejects(() => startManagedWebhookProxy(stuck.options), { reason: 'startup_cleanup_not_confirmed' });
  assert.deepEqual(stuck.child.signals, ['SIGTERM', 'SIGKILL']);
});

test('unexpected child exit notifies once without raw errors; normal idempotent stop never notifies', async () => {
  const f = fixture(); const managed = await startManagedWebhookProxy(f.options);
  f.child.emit('error', Error('raw ' + PROXY_URL)); f.child.finish(); f.child.emit('error', Error('another raw secret'));
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].reason, 'child_exited');
  assert.doesNotMatch(JSON.stringify(f.failures), /synthetic|password|127\.0\.0\.1|http:/);
  await managed.stop(); assert.deepEqual(f.child.signals, []);
  const stopped = fixture(); const second = await startManagedWebhookProxy(stopped.options);
  const firstStop = second.stop(), secondStop = second.stop(); assert.equal(firstStop, secondStop);
  await firstStop; await second.stop();
  assert.deepEqual(stopped.child.signals, ['SIGTERM']); assert.deepEqual(stopped.failures, []);
});

test('open/fstat identity change and spawn error event cannot be mistaken for a ready managed listener', async () => {
  const raced = fixture(), originalFstat = raced.deps.fs.fstatSync;
  raced.deps.fs.fstatSync = fd => ({ ...originalFstat(fd), ino: 99999 });
  await assert.rejects(() => startManagedWebhookProxy(raced.options), { reason: 'filesystem_rejected' });
  assert.equal(raced.descriptors.size, 0); assert.equal(raced.spawnCalls.length, 0);
  const f = fixture(); f.deps.spawn = () => { queueMicrotask(() => f.child.emit('error', Error('raw ' + PROXY_URL))); return f.child; };
  await assert.rejects(() => startManagedWebhookProxy(f.options), { reason: 'start_failed' });
  assert.deepEqual(f.child.signals, ['SIGTERM']); assert.deepEqual(f.failures, []);
});
