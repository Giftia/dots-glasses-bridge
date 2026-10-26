import * as nodeFs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { createProxyWebhookTransport } from './proxy-webhook.mjs';

export const MANAGED_PROXY_BINARY_SHA256 = '907ba8c9693edb104b20582681fb7dc15639d5b64a9cbb616a7b539190a86691';
const START_TIMEOUT = 8000;
const STOP_GRACE = 1500;
const STOP_KILL_WAIT = 1500;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class ManagedWebhookProxyError extends Error {
  constructor(reason) {
    super('Managed webhook proxy ' + reason);
    this.name = 'ManagedWebhookProxyError';
    this.code = 'MANAGED_WEBHOOK_PROXY_ERROR';
    this.reason = reason;
  }
}
const fail = reason => { throw new ManagedWebhookProxyError(reason); };

function keysAre(value, allowed, required = []) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function validateConfiguration(config, proxyText) {
  if (!keysAre(config, ['server', 'auth', 'tls', 'http', 'lazy'], ['server', 'auth', 'tls', 'http'])
    || (config.lazy !== undefined && config.lazy !== false)
    || typeof config.server !== 'string' || !config.server || config.server.length > 512 || /[\s\/@?#]/.test(config.server)
    || typeof config.auth !== 'string' || !config.auth || config.auth.length > 4096 || /[\x00-\x1f\x7f]/.test(config.auth)
    || !keysAre(config.tls, ['sni', 'insecure'], ['sni', 'insecure']) || config.tls.insecure !== false
    || typeof config.tls.sni !== 'string' || config.tls.sni.length > 253
    || !config.tls.sni.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
    || !config.tls.sni.includes('.')
    || !keysAre(config.http, ['listen', 'username', 'password', 'realm'], ['listen', 'username', 'password'])
    || config.http.listen !== '127.0.0.1:17327'
    || typeof config.http.username !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(config.http.username)
    || typeof config.http.password !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(config.http.password)
    || (config.http.realm !== undefined && (typeof config.http.realm !== 'string' || config.http.realm.length > 128 || /[\x00-\x1f\x7f]/.test(config.http.realm)))) fail('configuration_rejected');
  try {
    const server = new URL('https://' + config.server);
    if (!server.hostname || server.username || server.password || server.pathname !== '/' || server.search || server.hash) fail('configuration_rejected');
  } catch { fail('configuration_rejected'); }
  const expected = 'http://' + config.http.username + ':' + config.http.password + '@127.0.0.1:17327';
  const proxyUrl = proxyText.replace(/\r?\n$/, '');
  if (proxyUrl !== expected && proxyUrl !== expected + '/') fail('configuration_rejected');
  return proxyUrl;
}

function inspectRuntime(root, fs, uid) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || dirname(root) === root) fail('filesystem_rejected');
  const paths = {
    binary: join(root, '.dot-events', 'proxy', 'hysteria'),
    config: join(root, '.dot-events', 'private', 'hysteria-client.json'),
    proxyUrl: join(root, '.dot-events', 'private', 'webhook-proxy.txt')
  };
  const assertAncestors = path => {
    for (let cursor = path; ; cursor = dirname(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor) fail('filesystem_rejected');
      if (dirname(cursor) === cursor) break;
    }
  };
  assertAncestors(root);
  const rootStat = fs.lstatSync(root);
  if (![0, uid].includes(rootStat.uid) || (rootStat.mode & 0o022) !== 0) fail('filesystem_rejected');
  for (const dir of [join(root, '.dot-events'), dirname(paths.binary), dirname(paths.config)]) {
    assertAncestors(dir);
    const stat = fs.lstatSync(dir);
    if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) fail('filesystem_rejected');
  }
  const read = (path, maxBytes, privateFile) => {
    const before = fs.lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes
      || fs.realpathSync(path) !== path || (privateFile && (before.uid !== uid || (before.mode & 0o777) !== 0o600))
      || (!privateFile && (![0, uid].includes(before.uid) || (before.mode & 0o022) !== 0))) fail('filesystem_rejected');
    const fd = fs.openSync(path, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || !opened.isFile()) fail('filesystem_rejected');
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0, count;
      while (offset < buffer.length && (count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)) > 0) offset += count;
      const after = fs.fstatSync(fd);
      if (offset !== before.size || after.size !== before.size || after.uid !== before.uid || after.mode !== before.mode
        || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || fs.realpathSync(path) !== path) fail('filesystem_rejected');
      return buffer.subarray(0, offset);
    } finally { fs.closeSync(fd); }
  };
  const binary = read(paths.binary, 64 * 1024 * 1024, false);
  if (createHash('sha256').update(binary).digest('hex') !== MANAGED_PROXY_BINARY_SHA256) fail('binary_rejected');
  fs.accessSync(paths.binary, nodeFs.constants.X_OK);
  let config, proxyText;
  try {
    config = JSON.parse(utf8.decode(read(paths.config, 16 * 1024, true)));
    proxyText = utf8.decode(read(paths.proxyUrl, 16 * 1024, true));
  } catch (error) {
    if (error instanceof ManagedWebhookProxyError) throw error;
    fail('configuration_rejected');
  }
  return { ...paths, proxyUrl: validateConfiguration(config, proxyText) };
}

function probePort(timeout = 250) {
  return new Promise((done, reject) => {
    let settled = false;
    const finish = (error, occupied) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(new ManagedWebhookProxyError('port_probe_failed'));
      else done(occupied);
    };
    const socket = connect({ host: '127.0.0.1', port: 17327 });
    const timer = setTimeout(() => finish(true), timeout);
    socket.once('connect', () => finish(false, true));
    socket.once('error', error => error.code === 'ECONNREFUSED' ? finish(false, false) : finish(true));
  });
}

/** Only the existing application process owns this child; no process discovery,
 * shell, global proxy variables, extra system service, or direct-send fallback. */
export async function startManagedWebhookProxy({ root, onFailure, deps = {} } = {}) {
  const fs = deps.fs || nodeFs;
  const uid = deps.getuid ? deps.getuid() : typeof process.getuid === 'function' ? process.getuid() : -1;
  const platform = deps.platform || process.platform;
  if (platform !== 'linux' || !Number.isInteger(uid) || uid <= 0 || (onFailure !== undefined && typeof onFailure !== 'function')) fail('runtime_rejected');
  let paths;
  try { paths = inspectRuntime(root, fs, uid); }
  catch (error) { if (error instanceof ManagedWebhookProxyError) throw error; fail('filesystem_rejected'); }
  const probe = deps.probePort || probePort;
  const spawn = deps.spawn || nodeSpawn;
  const now = deps.now || (() => performance.now());
  const pause = deps.sleep || sleep;
  const createTransport = deps.createTransport || createProxyWebhookTransport;
  let occupied;
  try { occupied = await probe(250); } catch { fail('port_probe_failed'); }
  if (occupied !== false) fail('port_already_in_use');
  let child, phase = 'starting', exited = false, failureNotified = false, stopPromise;
  let signalExit;
  const exit = new Promise(done => { signalExit = done; });
  let signalError;
  const childError = new Promise(done => { signalError = done; });
  const notify = () => {
    if (phase !== 'running' || failureNotified) return;
    phase = 'failed'; failureNotified = true;
    if (onFailure) { try { onFailure(new ManagedWebhookProxyError('child_exited')); } catch { /* Never echo a callback's raw error. */ } }
  };
  const onExit = () => { exited = true; signalExit(); notify(); };
  const onError = () => { signalError('child-error'); notify(); };
  const waitForExit = async ms => {
    if (deps.sleep) { await Promise.race([exit, pause(ms)]); return; }
    let timer;
    try { await Promise.race([exit, new Promise(done => { timer = setTimeout(done, ms); })]); }
    finally { clearTimeout(timer); }
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    phase = 'stopping';
    stopPromise = (async () => {
      if (!child || exited || !Number.isInteger(child.pid) || child.pid <= 0) { phase = 'stopped'; return; }
      try { child.kill('SIGTERM'); } catch { /* Reconcile only through this child's exit event. */ }
      await waitForExit(STOP_GRACE);
      if (!exited) {
        try { child.kill('SIGKILL'); } catch { /* The bounded wait below determines the result. */ }
        await waitForExit(STOP_KILL_WAIT);
      }
      if (!exited) fail('stop_not_confirmed');
      phase = 'stopped';
    })();
    return stopPromise;
  };
  try {
    child = spawn(paths.binary, ['client', '--config', paths.config], { cwd: root, stdio: 'ignore', shell: false, detached: false, windowsHide: true });
    if (!child || typeof child.once !== 'function' || typeof child.on !== 'function' || typeof child.kill !== 'function') fail('start_failed');
    child.once('exit', onExit);
    child.on('error', onError);
    if (child.exitCode !== null && child.exitCode !== undefined) onExit();
    let timer;
    const deadline = now() + START_TIMEOUT;
    const waitForListener = async () => {
      while (phase === 'starting' && !exited && now() < deadline) {
        const result = await probe(Math.max(1, Math.min(250, deadline - now())));
        if (exited || phase !== 'starting') return 'child-exit';
        if (result === true) return 'ready';
        if (result !== false) return 'probe-failed';
        await pause(Math.max(1, Math.min(100, deadline - now())));
      }
      return 'timeout';
    };
    let outcome;
    try {
      outcome = await Promise.race([
        waitForListener(), exit.then(() => 'child-exit'), childError,
        new Promise(done => { timer = setTimeout(() => done('timeout'), START_TIMEOUT); })
      ]);
    } finally { clearTimeout(timer); }
    if (outcome !== 'ready' || exited || !Number.isInteger(child.pid) || child.pid <= 0) fail(outcome === 'timeout' ? 'start_timeout' : 'start_failed');
    const transport = createTransport(paths.proxyUrl);
    if (!transport || typeof transport.verifyCallback !== 'function' || typeof transport.sendEvent !== 'function') fail('start_failed');
    phase = 'running';
    return { transport, stop };
  } catch (error) {
    try { await stop(); } catch { fail('startup_cleanup_not_confirmed'); }
    if (error instanceof ManagedWebhookProxyError) throw error;
    fail('start_failed');
  }
}
