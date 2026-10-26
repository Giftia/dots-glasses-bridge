import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { initialize, parseArguments, restrictDirectory } from '../deploy/init.mjs';
import { hashOwnerCode } from '../lib/oauth.mjs';

const base = 'https://owner.example/dots';
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dots-init-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh installation has separate credentials, private absolute paths and safe metadata', t => {
  const installDir = temporary(t), result = initialize({ installDir, publicBaseUrl: base });
  const config = JSON.parse(readFileSync(result.configPath, 'utf8'));
  const ownerCode = readFileSync(result.ownerCodePath, 'utf8').trim();
  assert.equal(config.publicBaseUrl, base);
  assert.equal(config.dataDir, join(installDir, '.dot-events', 'data'));
  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.port, 17326);
  assert.match(ownerCode, /^[A-Za-z0-9_-]{43}$/);
  assert.match(config.platformToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(config.platformToken, ownerCode);
  assert.equal(config.ownerCodeHash, hashOwnerCode(ownerCode));
  const manifest = readFileSync(result.manifestPath, 'utf8');
  assert.deepEqual(JSON.parse(manifest), result);
  assert.ok(!manifest.includes(ownerCode));
  assert.ok(!manifest.includes(config.platformToken));
  const original = readFileSync(result.configPath);
  assert.throws(() => initialize({ installDir, publicBaseUrl: base }), /already exists/);
  assert.deepEqual(readFileSync(result.configPath), original);
  if (process.platform !== 'win32') {
    for (const path of [result.runtimeRoot, result.privateDir, result.dataDir]) assert.equal(statSync(path).mode & 0o777, 0o700);
    for (const path of [result.configPath, result.ownerCodePath, result.manifestPath]) assert.equal(statSync(path).mode & 0o777, 0o600);
  } else {
    // Inspect identity only; never print the private files or their contents.
    const aclFile = join(installDir, 'test-acl.txt');
    execFileSync('icacls.exe', [result.runtimeRoot, '/save', aclFile], { windowsHide: true, stdio: 'pipe' });
    const acl = readFileSync(aclFile, 'utf16le');
    const dacl = acl.match(/D:([^\r\n]*)/)?.[1]?.split(/S:|O:|G:/)[0] || '';
    const entries = dacl.match(/\([^)]*\)/g) || [];
    const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.match(/S-1-\d+(?:-\d+)+/)[0];
    assert.equal(entries.length, 2);
    assert.ok(entries.some(entry => entry.endsWith(';;;SY)')));
    assert.ok(entries.some(entry => entry.endsWith(';;;' + sid + ')')));
    assert.ok(entries.every(entry => entry.startsWith('(A;OICI;FA;;;')));
  }
});

test('permission setup refuses existing contents and removes extra explicit access from a new Windows directory', t => {
  const occupied = temporary(t);writeFileSync(join(occupied,'keep.txt'),'preserve');
  assert.throws(() => restrictDirectory(occupied), /empty directory/);
  assert.equal(readFileSync(join(occupied,'keep.txt'),'utf8'),'preserve');
  if (process.platform !== 'win32') return;
  const directory=temporary(t);
  execFileSync('icacls.exe',[directory,'/grant:r','*S-1-1-0:(OI)(CI)F'],{windowsHide:true,stdio:'pipe'});
  restrictDirectory(directory);
  const aclFile=join(directory,'test-acl.txt');
  execFileSync('icacls.exe',[directory,'/save',aclFile],{windowsHide:true,stdio:'pipe'});
  const text=readFileSync(aclFile,'utf16le');
  assert.doesNotMatch(text,/;;;WD\)/);
  const dacl=text.match(/D:([^\r\n]*)/)?.[1]?.split(/S:|O:|G:/)[0] || '';
  assert.equal((dacl.match(/\([^)]*\)/g)||[]).length,2);
});

test('URL validation rejects insecure or ambiguous issuers before any runtime creation', t => {
  const installDir = temporary(t);
  for (const publicBaseUrl of [undefined, '', 'http://owner.example/dots', 'https://name:secret@owner.example/dots', 'https://owner.example/dots?x=1', 'https://owner.example/dots#x', 'https://owner.example/dots?', 'https://owner.example/dots#', 'https://owner.example/dots/', 'https://owner.example/other', 'https://owner.example/a/../dots']) {
    assert.throws(() => initialize({ installDir, publicBaseUrl }), /HTTPS/);
    assert.equal(existsSync(join(installDir, '.dot-events')), false);
  }
});

test('port validation rejects invalid values and preserves a valid explicit port', t => {
  const installDir = temporary(t);
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '17326', null]) {
    assert.throws(() => initialize({ installDir, publicBaseUrl: base, port }), /Port/);
    assert.equal(existsSync(join(installDir, '.dot-events')), false);
  }
  const result = initialize({ installDir, publicBaseUrl: base, port: 17327 });
  assert.equal(JSON.parse(readFileSync(result.configPath, 'utf8')).port, 17327);
});

test('directory validation rejects relative, missing, file and root locations', t => {
  const dir = temporary(t), file = join(dir, 'file'); writeFileSync(file, 'fixture');
  for (const installDir of ['relative', join(dir, 'missing'), file, parse(resolve(dir)).root]) assert.throws(() => initialize({ installDir, publicBaseUrl: base }), /directory|directories|root/);
});

test('existing partial runtime is retained without overwriting', t => {
  const installDir = temporary(t), runtime = join(installDir, '.dot-events');
  mkdirSync(runtime); writeFileSync(join(runtime, 'marker'), 'keep');
  assert.throws(() => initialize({ installDir, publicBaseUrl: base }), /already exists/);
  assert.equal(readFileSync(join(runtime, 'marker'), 'utf8'), 'keep');
});

test('symlink installation ancestor and dangling runtime are refused', t => {
  const root = temporary(t), actual = join(root, 'actual'), link = join(root, 'link');
  mkdirSync(actual); mkdirSync(join(actual, 'child'));
  try { symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation is not permitted on this host'); return; } throw error; }
  assert.throws(() => initialize({ installDir: join(link, 'child'), publicBaseUrl: base }), /real existing/);
  const runtime = join(actual, '.dot-events');
  symlinkSync(join(root, 'absent'), runtime, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => initialize({ installDir: actual, publicBaseUrl: base }), /already exists/);
});

test('CLI requires explicit paths and URL, rejects duplicate, unknown and malformed arguments', () => {
  assert.deepEqual(parseArguments(['--install-dir', '/example', '--public-base-url', base, '--port', '17326']), { installDir: '/example', publicBaseUrl: base, port: 17326 });
  for (const args of [['--port', '2e3'], ['--port', '1.5'], ['--install-dir'], ['--unknown', 'x'], ['--port', '17326', '--port', '17327']]) assert.throws(() => parseArguments(args), /Usage|Port/);
  const missing = spawnSync(process.execPath, ['deploy/init.mjs'], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(missing.status, 1);
});

test('CLI output contains metadata but no secret credential values', t => {
  const installDir = temporary(t);
  const result = spawnSync(process.execPath, ['deploy/init.mjs', '--install-dir', installDir, '--public-base-url', base], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout), config = JSON.parse(readFileSync(metadata.configPath, 'utf8')), owner = readFileSync(metadata.ownerCodePath, 'utf8').trim();
  assert.ok(!result.stdout.includes(config.platformToken));
  assert.ok(!result.stdout.includes(owner));
  assert.equal(result.stderr, '');
});
