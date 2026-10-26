import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initialize } from '../deploy/init.mjs';
import { initializeWeixin } from '../deploy/init-weixin.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dots-weixin-init-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return initialize({ installDir: dir, publicBaseUrl: 'https://owner.example/dots' });
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));

test('optional setup preserves existing fields and exact backup bytes with separate credentials', t => {
  const install = fixture(t), old = read(install.configPath);
  old.extra = { preserved: true }; writeFileSync(install.configPath, JSON.stringify(old) + '\n');
  const bytes = readFileSync(install.configPath), result = initializeWeixin(install.configPath);
  const config = read(install.configPath), connection = read(result.connectionPath), inbound = read(result.inboundPath);
  for (const [key, value] of Object.entries(old)) assert.deepEqual(config[key], value);
  assert.match(config.weixinRelayToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(config.weixinIngressToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([config.platformToken, config.weixinRelayToken, config.weixinIngressToken]).size, 3);
  assert.equal(connection.token, config.weixinRelayToken);
  assert.equal(inbound.token, config.weixinIngressToken);
  assert.equal(connection.format, 'dots-weixin-relay-connection-v1');
  assert.equal(inbound.format, 'dots-weixin-inbound-v1');
  assert.equal(connection.after, 'MA'); assert.equal(connection.since, inbound.activatedAt);
  assert.deepEqual(readFileSync(result.backupPath), bytes);
  const manifest = readFileSync(result.manifestPath, 'utf8'), output = JSON.stringify(result);
  assert.ok(manifest.includes(createHash('sha256').update(bytes).digest('hex')));
  for (const token of [config.platformToken, connection.token, inbound.token]) { assert.ok(!output.includes(token)); assert.ok(!manifest.includes(token)); }
  const changed = readFileSync(install.configPath);
  assert.throws(() => initializeWeixin(install.configPath), /already exists|partial/);
  assert.deepEqual(readFileSync(install.configPath), changed);
});

test('cursor starts after the persisted notification sequence', t => {
  const install = fixture(t), core = join(install.dataDir, 'event-core'); mkdirSync(core);
  writeFileSync(join(core, 'state.json'), JSON.stringify({ notificationSequence: 125 }));
  const result = initializeWeixin(install.configPath);
  assert.equal(read(result.connectionPath).after, Buffer.from('125').toString('base64url'));
  assert.equal(result.notificationSequence, 125);
});

test('invalid sequence refuses to write configuration or setup', t => {
  const install = fixture(t), core = join(install.dataDir, 'event-core'); mkdirSync(core);
  const bytes = readFileSync(install.configPath);
  for (const notificationSequence of [-1, 2.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    writeFileSync(join(core, 'state.json'), JSON.stringify({ notificationSequence }));
    assert.throws(() => initializeWeixin(install.configPath), /notificationSequence/);
    assert.deepEqual(readFileSync(install.configPath), bytes);
    assert.equal(existsSync(join(install.privateDir, 'weixin-setup')), false);
  }
  writeFileSync(join(core, 'state.json'), JSON.stringify({ tasks: [{ id: 'synthetic-old-task' }] }));
  assert.throws(() => initializeWeixin(install.configPath), /notificationSequence/);
  assert.deepEqual(readFileSync(install.configPath), bytes);
  assert.equal(existsSync(join(install.privateDir, 'weixin-setup')), false);
});

test('partial tokens or partial setup are never overwritten', t => {
  const install = fixture(t), config = read(install.configPath);
  config.weixinRelayToken = 'existing'; writeFileSync(install.configPath, JSON.stringify(config));
  assert.throws(() => initializeWeixin(install.configPath), /already exists|partial/);
  delete config.weixinRelayToken; writeFileSync(install.configPath, JSON.stringify(config));
  mkdirSync(join(install.privateDir, 'weixin-setup'));
  assert.throws(() => initializeWeixin(install.configPath), /already exists|partial/);
  assert.throws(() => initializeWeixin('relative'), /absolute/);
  assert.throws(() => initializeWeixin(join(install.privateDir, 'missing.json')), /missing|unsafe/);
});

test('CLI prints only safe metadata and requires explicit config', t => {
  const install = fixture(t);
  const run = spawnSync(process.execPath, ['deploy/init-weixin.mjs', '--config', install.configPath], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout), config = read(install.configPath);
  assert.equal(result.restartRequired, true);
  for (const token of [config.platformToken, config.weixinRelayToken, config.weixinIngressToken]) assert.ok(!run.stdout.includes(token));
  const bad = spawnSync(process.execPath, ['deploy/init-weixin.mjs'], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('unsafe linked configuration and malformed event state are refused before writes', t => {
  const install = fixture(t), alias = join(install.privateDir, 'alias.json');
  linkSync(install.configPath, alias);
  assert.throws(() => initializeWeixin(alias), /unsafe/);
  rmSync(alias);
  const linked = join(install.installDir, 'linked-private');
  try { symlinkSync(install.privateDir, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (existsSync(linked)) assert.throws(() => initializeWeixin(join(linked, 'config.json')), /real directories/);
  const core = join(install.dataDir, 'event-core'); mkdirSync(core);
  writeFileSync(join(core, 'state.json'), '{invalid');
  assert.throws(() => initializeWeixin(install.configPath), /JSON is invalid/);
  assert.equal(existsSync(join(install.privateDir, 'weixin-setup')), false);
});
