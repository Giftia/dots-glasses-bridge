import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, symlinkSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { MediaStore, MediaError, MEDIA_LIMITS } from '../lib/media.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const WEBP = Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary');
const PUBLIC = async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];

function requester({ type = 'image/jpeg', bytes = JPEG, headers = {}, status = 200, chunks, hold = false, error = false } = {}) {
  const calls = [];
  const request = (options, callback) => {
    const req = new EventEmitter(); req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      setImmediate(() => {
        if (req.destroyed) return;
        const stream = hold ? new PassThrough() : Readable.from(chunks || [bytes]);
        stream.statusCode = status; stream.headers = { 'content-type': type, ...headers };
        calls[calls.length - 1].response = stream; callback(stream);
        if (error) stream.destroy(new Error('https://secret.example/?token=DO_NOT_EXPOSE'));
      });
    };
    calls.push({ options, req }); return req;
  };
  request.calls = calls; return request;
}

function fixture(t, options = {}) {
  const base = join(ROOT, 'work', 'media-tests'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1780000000000;
  const request = options.request || requester(options);
  const store = new MediaStore(dir, { now: () => now, lookup: options.lookup || PUBLIC, request });
  return { dir, store, request, advance: ms => { now += ms; }, restart: () => new MediaStore(dir, { now: () => now, lookup: PUBLIC, request }) };
}
const source = 'https://photo.example/capture.jpg?token=PRIVATE_SOURCE_TOKEN';
const expectReason = reason => error => error instanceof MediaError && error.reason === reason && !error.message.includes('PRIVATE_SOURCE_TOKEN');
const noTemps = store => assert.equal(readdirSync(store.dir).some(name => name.startsWith('.download-') || name.startsWith('.manifest-')), false);

test('media preserves exact original image bytes, hash, private manifest, typed image and restart', async t => {
  const f = fixture(t);
  const meta = await f.store.ingest({ url: source, owner: 'alice', fileName: '眼镜照片.jpg' });
  assert.match(meta.id, /^media_[a-f0-9]{32}$/);
  assert.equal(meta.mimeType, 'image/jpeg'); assert.equal(meta.size, JPEG.length);
  assert.equal(meta.sha256, createHash('sha256').update(JPEG).digest('hex'));
  assert.equal(meta.expiresAt, 1780000000000 + MEDIA_LIMITS.lifetime);
  assert.equal(meta.fileName, '眼镜照片.jpg'); assert.equal('owner' in meta, false);
  assert.deepEqual(f.store.readImage(meta.id, 'alice'), { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' });
  assert.deepEqual(f.restart().get(meta.id, 'alice'), meta);
  assert.deepEqual(readFileSync(f.store.resolveAsset(meta.id, 'alice').path), JPEG);
  const manifest = readFileSync(f.store.path, 'utf8');
  assert.equal(manifest.includes('photo.example'), false); assert.equal(manifest.includes('PRIVATE_SOURCE_TOKEN'), false); assert.equal(manifest.includes('download_url'), false);
  noTemps(f.store);
});

test('media transport pins the checked public IP while retaining TLS hostname and bounded encoding', async t => {
  const f = fixture(t); await f.store.ingest({ url: source });
  const options = f.request.calls[0].options;
  assert.equal(options.hostname, 'photo.example'); assert.equal(options.servername, 'photo.example'); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false); assert.equal(options.method, 'GET'); assert.equal(options.headers['Accept-Encoding'], 'identity');
  await new Promise(resolvePin => options.lookup('photo.example', {}, (_error, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); resolvePin(); }));
});

test('media accepts JPEG, PNG and WebP magic even split across streamed chunks', async t => {
  for (const [type, bytes] of [['image/jpeg', JPEG], ['image/png', PNG], ['image/webp', WEBP]]) {
    const f = fixture(t, { type, chunks: [...bytes].map(byte => Buffer.from([byte])) });
    const meta = await f.store.ingest({ url: source, mimeType: type });
    assert.equal(meta.mimeType, type); assert.equal(f.store.readImage(meta.id).data, bytes.toString('base64'));
  }
});

test('media rejects private DNS answers, including mixed public/private sets before making a request', async t => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]]) {
    const f = fixture(t, { lookup: async () => addresses });
    await assert.rejects(f.store.ingest({ url: source }), expectReason('non_public_address'));
    assert.equal(f.request.calls.length, 0); noTemps(f.store);
  }
});

test('media rejects non-HTTPS, credentials, fragments, malformed URLs and metadata literals', async t => {
  const f = fixture(t);
  for (const url of ['http://photo.example/a', 'https://user:secret@photo.example/a', 'https://photo.example/a#secret', 'not a url', 'https://169.254.169.254/latest', 'https://[::1]/a']) {
    await assert.rejects(f.store.ingest({ url }), error => error instanceof MediaError && ['invalid_url', 'non_public_address'].includes(error.reason));
  }
  assert.equal(f.request.calls.length, 0);
});

test('media rejects redirects without following Location', async t => {
  const f = fixture(t, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  await assert.rejects(f.store.ingest({ url: source }), expectReason('redirect'));
  assert.equal(f.request.calls.length, 1); assert.equal(f.request.calls[0].req.destroyed, true); noTemps(f.store);
});

test('media rejects HTTP errors, unsafe MIME, encoding and MIME/magic disagreement', async t => {
  for (const [options, reason] of [
    [{ status: 404 }, 'download_failed'], [{ type: 'text/html' }, 'unsupported_type'],
    [{ type: 'image/png' }, 'invalid_content'], [{ headers: { 'content-encoding': 'gzip' } }, 'unsupported_encoding'],
    [{ type: 'image/jpeg', bytes: Buffer.from('<script>alert(1)</script>') }, 'invalid_content']
  ]) {
    const f = fixture(t, options); await assert.rejects(f.store.ingest({ url: source }), expectReason(reason)); noTemps(f.store);
  }
  const f = fixture(t); await assert.rejects(f.store.ingest({ url: source, mimeType: 'image/png' }), expectReason('unsupported_type'));
});

test('media rejects an image over 4 MiB while streaming without buffering the whole body', async t => {
  const chunks = function* () { yield JPEG; for (let i = 0; i < 66; i++) yield Buffer.alloc(64 * 1024); };
  const f = fixture(t, { chunks: chunks() });
  await assert.rejects(f.store.ingest({ url: source }), expectReason('too_large'));
  assert.equal(JSON.parse(readFileSync(f.store.path, 'utf8')).assets.length, 0); noTemps(f.store);
});

test('media enforces declared length, including early oversize and truncation', async t => {
  for (const [length, reason] of [[String(MEDIA_LIMITS.image + 1), 'too_large'], ['999', 'invalid_length'], ['-1', 'invalid_length'], ['NaN', 'invalid_length'], ['9007199254740992', 'invalid_length']]) {
    const f = fixture(t, { headers: { 'content-length': length } });
    await assert.rejects(f.store.ingest({ url: source }), expectReason(reason)); noTemps(f.store);
  }
});

test('media allows PDF/plain UTF-8 files and safe names; file replies can also hold images', async t => {
  for (const [type, bytes] of [['application/pdf', Buffer.from('%PDF-1.7\nexample')], ['text/plain; charset=utf-8', Buffer.from('照片中的文字\n安全附件')], ['image/png', PNG]]) {
    const f = fixture(t, { type, chunks: [...bytes].map(byte => Buffer.from([byte])) });
    const meta = await f.store.ingest({ url: source, kind: 'file', fileName: '../<>unsafe\r\nname.txt' });
    assert.equal(meta.kind, 'file'); assert.equal(/[\/\\<>\r\n]/.test(meta.fileName), false);
    if (meta.mimeType.startsWith('image/')) assert.equal(f.store.readImage(meta.id).mimeType, 'image/png');
    else assert.throws(() => f.store.readImage(meta.id), expectReason('not_image'));
  }
});

test('media filename truncation remains stable across manifest restart', async t => {
  const f = fixture(t), name = 'a'.repeat(119) + '. remainder.jpg';
  const meta = await f.store.ingest({ url: source, fileName: name });
  assert.equal(meta.fileName, 'a'.repeat(119));
  assert.equal(f.restart().get(meta.id).fileName, meta.fileName);
});

test('media rejects fake PDF, control bytes and malformed UTF-8 plain files', async t => {
  for (const [type, bytes] of [['application/pdf', JPEG], ['text/plain', Buffer.from('a\0b')], ['text/plain', Buffer.from([0xff, 0xfe])], ['text/plain', Buffer.from([0xe4, 0xb8])]]) {
    const f = fixture(t, { type, bytes });
    await assert.rejects(f.store.ingest({ url: source, kind: 'file' }), expectReason('invalid_content')); noTemps(f.store);
  }
});

test('media file size limit is 8 MiB and image size remains 4 MiB even under file kind', async t => {
  const f = fixture(t, { type: 'application/pdf', headers: { 'content-length': String(MEDIA_LIMITS.file + 1) } });
  await assert.rejects(f.store.ingest({ url: source, kind: 'file' }), expectReason('too_large'));
  const image = fixture(t, { headers: { 'content-length': String(MEDIA_LIMITS.image + 1) } });
  await assert.rejects(image.store.ingest({ url: source, kind: 'file' }), expectReason('too_large'));
});

test('media separates owners, rejects path traversal and expires without deleting original files', async t => {
  const f = fixture(t), meta = await f.store.ingest({ url: source, owner: 'alice' });
  assert.throws(() => f.store.get(meta.id, 'bob'), expectReason('not_found'));
  assert.throws(() => f.store.get('../manifest', 'alice'), expectReason('not_found'));
  f.advance(MEDIA_LIMITS.lifetime);
  assert.throws(() => f.store.get(meta.id, 'alice'), expectReason('expired'));
  assert.equal(readdirSync(f.store.dir).includes(meta.id + '.bin'), true);
  assert.equal(f.restart().usage() > JPEG.length, true);
});

test('media quota includes expired assets and unrecognized leftover regular files', async t => {
  const f = fixture(t), meta = await f.store.ingest({ url: source }); f.advance(MEDIA_LIMITS.lifetime);
  const path = join(f.store.dir, '.download-orphan.tmp'), fd = openSync(path, 'wx');
  ftruncateSync(fd, MEDIA_LIMITS.quota); closeSync(fd);
  const requestCount = f.request.calls.length;
  await assert.rejects(f.store.ingest({ url: source }), expectReason('quota_exceeded'));
  assert.equal(f.request.calls.length, requestCount);
  assert.equal(readdirSync(f.store.dir).includes(meta.id + '.bin'), true);
  assert.equal(readdirSync(f.store.dir).includes('.download-orphan.tmp'), true);
});

test('media stops a streamed transfer that would exceed total quota and preserves old files', async t => {
  const f = fixture(t, { chunks: [JPEG, Buffer.alloc(8192)] });
  const orphan = join(f.store.dir, 'old.bin'), fd = openSync(orphan, 'wx');
  ftruncateSync(fd, MEDIA_LIMITS.quota - 1024); closeSync(fd);
  await assert.rejects(f.store.ingest({ url: source }), expectReason('quota_exceeded'));
  assert.equal(readdirSync(f.store.dir).includes('old.bin'), true); noTemps(f.store);
});

test('media rejects missing or tampered assets instead of serving another file', async t => {
  const f = fixture(t), meta = await f.store.ingest({ url: source });
  const { path } = f.store.resolveAsset(meta.id); writeFileSync(path, Buffer.alloc(JPEG.length));
  assert.throws(() => f.store.readImage(meta.id), expectReason('asset_changed'));
  rmSync(path); assert.throws(() => f.store.get(meta.id), expectReason('asset_unavailable'));
});

test('media get checks SHA-256 for PDF and text files, using the same owner and expiry checks', async t => {
  for (const [type, bytes] of [['application/pdf', Buffer.from('%PDF-1.7\nexample')], ['text/plain', Buffer.from('hello')]]) {
    const f = fixture(t, { type, bytes }), meta = await f.store.ingest({ url: source, kind: 'file', owner: 'alice' });
    const { path } = f.store.resolveAsset(meta.id, 'alice');
    assert.equal(f.store.get(meta.id, 'alice').mimeType, type);
    writeFileSync(path, Buffer.alloc(bytes.length));
    assert.throws(() => f.store.get(meta.id, 'alice'), expectReason('asset_changed'));
    assert.throws(() => f.store.resolveAsset(meta.id, 'alice'), expectReason('asset_changed'));
  }
});

test('media refuses manifest symlinks and parent directory junctions', async t => {
  const f = fixture(t), original = join(f.dir, 'actual-media'); renameSync(f.store.dir, original);
  symlinkSync(original, f.store.dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.restart(), expectReason('unsafe_directory'));
});

test('media refuses an asset file symlink and a manifest file symlink', async t => {
  const f = fixture(t), meta = await f.store.ingest({ url: source });
  const asset = f.store.resolveAsset(meta.id).path, actual = join(f.dir, 'actual.bin');
  renameSync(asset, actual);
  try { symlinkSync(actual, asset, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Creating Windows file symlinks needs Developer Mode or privilege'); return; } throw error; }
  assert.throws(() => f.store.get(meta.id), expectReason('unsafe_asset'));
  assert.throws(() => f.restart(), expectReason('unsafe_asset'));
  rmSync(asset); renameSync(actual, asset);
  const manifest = join(f.dir, 'actual-manifest.json'); renameSync(f.store.path, manifest); symlinkSync(manifest, f.store.path, 'file');
  assert.throws(() => f.restart(), expectReason('invalid_manifest'));
});

test('media refuses unexpected fields, oversized manifests and legacy deployment directory', t => {
  const f = fixture(t); const original = readFileSync(f.store.path, 'utf8');
  writeFileSync(f.store.path, JSON.stringify({ ...JSON.parse(original), download_url: source }));
  assert.throws(() => f.restart(), expectReason('invalid_manifest'));
  writeFileSync(f.store.path, Buffer.alloc(MEDIA_LIMITS.manifest + 1));
  assert.throws(() => f.restart(), expectReason('invalid_manifest'));
  writeFileSync(f.store.path, original); writeFileSync(join(f.dir, 'credentials.json'), '{}');
  assert.throws(() => f.restart(), expectReason('legacy_directory'));
});

test('media returns only safe errors for network failures', async t => {
  const f = fixture(t, { error: true });
  await assert.rejects(f.store.ingest({ url: source }), error => expectReason('download_failed')(error) && !error.message.includes('DO_NOT_EXPOSE'));
  noTemps(f.store);
});

test('media rollback removes exactly this operation new files, preserving other assets and old data', async t => {
  const f = fixture(t), old = await f.store.ingest({ url: source, owner: 'alice' });
  const store = f.restart(), keep = await store.ingest({ url: source, owner: 'alice' });
  const first = await store.ingest({ url: source, owner: 'alice' }), second = await store.ingest({ url: source, owner: 'alice' });
  const before = store.usage();
  assert.equal(store.rollbackCreated([first.id, second.id], 'alice'), 2);
  assert.equal(store.get(old.id, 'alice').sha256, old.sha256); assert.equal(store.get(keep.id, 'alice').sha256, keep.sha256);
  for (const meta of [first, second]) { assert.throws(() => store.get(meta.id, 'alice'), expectReason('not_found')); assert.equal(existsSync(join(store.dir, meta.id + '.bin')), false); }
  assert.equal(store.usage() < before - first.size - second.size, true);
  assert.throws(() => store.rollbackCreated([old.id], 'alice'), expectReason('rollback_not_created'));
  assert.equal(store.rollbackCreated([], 'alice'), 0); noTemps(store);
});

test('media rollback validates every ID and owner before any manifest change or file deletion', async t => {
  const f = fixture(t), first = await f.store.ingest({ url: source, owner: 'alice' }), second = await f.store.ingest({ url: source, owner: 'bob' });
  const before = readFileSync(f.store.path, 'utf8');
  for (const [ids, owner, reason] of [
    [[first.id, first.id], 'alice', 'invalid_rollback'],
    [[first.id, '../manifest'], 'alice', 'invalid_rollback'],
    [[first.id, 'media_' + '0'.repeat(32)], 'alice', 'rollback_not_created'],
    [[first.id], 'bob', 'rollback_not_owned'],
    [[first.id, second.id], 'alice', 'rollback_not_owned']
  ]) {
    assert.throws(() => f.store.rollbackCreated(ids, owner), expectReason(reason));
    assert.equal(readFileSync(f.store.path, 'utf8'), before);
    assert.equal(f.store.get(first.id, 'alice').size, first.size); assert.equal(f.store.get(second.id, 'bob').size, second.size);
  }
});

test('media rollback SHA/path validation failure preserves every requested record and file', async t => {
  const f = fixture(t), first = await f.store.ingest({ url: source }), second = await f.store.ingest({ url: source });
  const before = readFileSync(f.store.path, 'utf8'), path = f.store.resolveAsset(second.id).path;
  writeFileSync(path, Buffer.alloc(second.size));
  assert.throws(() => f.store.rollbackCreated([first.id, second.id]), expectReason('asset_changed'));
  assert.equal(readFileSync(f.store.path, 'utf8'), before); assert.equal(f.store.get(first.id).size, first.size);
  assert.equal(existsSync(path), true); assert.equal(existsSync(join(f.store.dir, first.id + '.bin')), true);
});

test('media rollback exposes failed exact unlinks and counts the leftover bytes against quota', async t => {
  const f = fixture(t), first = await f.store.ingest({ url: source }), second = await f.store.ingest({ url: source });
  const residuePath = f.store.resolveAsset(first.id).path, actualUnlink = fs.unlinkSync;
  try {
    fs.unlinkSync = path => { if (path === residuePath) { const error = new Error('fixture locked'); error.code = 'EACCES'; throw error; } return actualUnlink(path); };
    syncBuiltinESMExports();
    assert.throws(() => f.store.rollbackCreated([first.id, second.id]), error => {
      assert.equal(error.reason, 'rollback_cleanup_incomplete'); assert.equal(error.status, 500);
      assert.equal(error.recordsRemoved, 2); assert.equal(error.removedCount, 1); assert.deepEqual(error.residueIds, [first.id]);
      assert.equal(error.message.includes(source), false); return true;
    });
  } finally { fs.unlinkSync = actualUnlink; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(readFileSync(f.store.path, 'utf8')).assets.length, 0);
  assert.equal(existsSync(residuePath), true); assert.equal(existsSync(join(f.store.dir, second.id + '.bin')), false);
  assert.equal(f.store.usage(), first.size + readFileSync(f.store.path).length);
  assert.throws(() => f.store.rollbackCreated([first.id]), expectReason('rollback_not_created'));
});

test('media global concurrency is one and the total deadline aborts a stalled stream', { timeout: 15000 }, async t => {
  const f = fixture(t, { hold: true }), other = fixture(t);
  const start = Date.now(), pending = f.store.ingest({ url: source });
  await assert.rejects(other.store.ingest({ url: source }), expectReason('busy'));
  await assert.rejects(pending, error => expectReason('timeout')(error) && error.status === 504);
  assert.equal(Date.now() - start >= 9500 && Date.now() - start < 14000, true);
  assert.equal(f.request.calls[0].req.destroyed, true); assert.equal(f.request.calls[0].response.destroyed, true); noTemps(f.store);
  assert.equal((await other.store.ingest({ url: source })).mimeType, 'image/jpeg');
});

test('media total deadline also covers a stalled DNS resolver', { timeout: 15000 }, async t => {
  const f = fixture(t, { lookup: () => new Promise(() => {}) });
  await assert.rejects(f.store.ingest({ url: source }), expectReason('timeout'));
  assert.equal(f.request.calls.length, 0); noTemps(f.store);
  const other = fixture(t); assert.equal((await other.store.ingest({ url: source })).mimeType, 'image/jpeg');
});

test('media import, stream ingest, private read and restart run in an isolated process', async t => {
  const executable = (process.env.DOTS_COMPAT_NODE || process.execPath);
  if (!existsSync(executable)) { t.skip('Optional local Node 16 runtime is absent'); return; }
  const f = fixture(t), moduleUrl = new URL('../lib/media.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { Readable } from 'node:stream';
    import { MediaStore } from ${JSON.stringify(moduleUrl)};
    const lookup = async () => [{address:'8.8.8.8',family:4}];
    const request = (options, callback) => {
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => setImmediate(() => { const stream = Readable.from([Buffer.from([255,216,255,224])]); stream.statusCode = 200; stream.headers = {'content-type':'image/jpeg'}; callback(stream); });
      return req;
    };
    const store = new MediaStore(${JSON.stringify(f.dir)}, { lookup, request });
    const meta = await store.ingest({url:'https://photo.example/a'});
    assert.equal(store.readImage(meta.id).data, '/9j/4A==');
    assert.equal(new MediaStore(${JSON.stringify(f.dir)}, { lookup, request }).get(meta.id).sha256, meta.sha256);
    assert.equal(store.rollbackCreated([meta.id]), 1);
    assert.throws(() => store.get(meta.id), error => error.reason === 'not_found');
    console.log(process.version + ' media smoke passed');
  `;
  const result = spawnSync(executable, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^v\d+\.\d+\.\d+ media smoke passed\r?\n$/);
});
