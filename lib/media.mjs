import https from 'node:https';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, fstatSync, realpathSync, mkdirSync, readdirSync, readFileSync, readSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, createWriteStream, constants } from 'node:fs';
import { resolve, join, dirname, parse, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import { validateCallbackUrl, WebhookError } from './webhook.mjs';

const FORMAT = 'dots-private-media-v1';
export const MEDIA_LIMITS = Object.freeze({ image: 4 * 1024 * 1024, file: 8 * 1024 * 1024, quota: 64 * 1024 * 1024, manifest: 1024 * 1024, lifetime: 24 * 60 * 60 * 1000, timeout: 10000 });
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FILE_TYPES = [...IMAGE_TYPES, 'application/pdf', 'text/plain'];
const ID = /^media_[a-f0-9]{32}$/;
let transferActive = false;
const createdByStore = new WeakMap();

export class MediaError extends Error {
  constructor(reason, status = 400) { super(`Media ${reason}`); this.name = 'MediaError'; this.reason = reason; this.status = status; this.code = 'MEDIA_ERROR'; }
}
const fail = (reason, status) => { throw new MediaError(reason, status); };
const clone = value => JSON.parse(JSON.stringify(value));
const safeOwner = owner => { if (typeof owner !== 'string' || !owner.trim() || owner.length > 128 || owner.includes('\0')) fail('invalid_owner'); return owner.trim(); };
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const publicMeta = record => { const { owner, ...meta } = record; return clone(meta); };
const normalizeMime = value => typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';

function assertRealDirectory(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(realpathSync(current), current)) fail('unsafe_directory', 500);
    }
    if (dirname(current) === current) break;
  }
}

function cleanFileName(name, mimeType) {
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' }[mimeType];
  let result = typeof name === 'string' ? name.normalize('NFKC').replace(/[\x00-\x1f\x7f-\x9f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120).replace(/[.\s]+$/g, '') : '';
  if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = 'attachment' + extension;
  return result;
}

function sniffImage(prefix) {
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (prefix.length >= 12 && prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'expiresAt,fileName,id,kind,mimeType,owner,sha256,size') fail('invalid_manifest', 500);
  if (!ID.test(record.id) || !['image', 'file'].includes(record.kind) || !FILE_TYPES.includes(record.mimeType) || record.kind === 'image' && !IMAGE_TYPES.includes(record.mimeType) ||
      typeof record.owner !== 'string' || safeOwner(record.owner) !== record.owner || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > MEDIA_LIMITS[record.kind] || IMAGE_TYPES.includes(record.mimeType) && record.size > MEDIA_LIMITS.image ||
      !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0 || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.fileName !== 'string' || cleanFileName(record.fileName, record.mimeType) !== record.fileName) fail('invalid_manifest', 500);
}

export class MediaStore {
  constructor(dataDir, { now = Date.now, lookup, request = https.request } = {}) {
    if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || resolve(dataDir) === parse(resolve(dataDir)).root) fail('invalid_directory');
    dataDir = resolve(dataDir); assertRealDirectory(dataDir);
    for (let current = dataDir; ; current = dirname(current)) {
      if (['credentials.json', 'bridge.sqlite', 'pairing.json', 'Caddyfile'].some(file => existsSync(join(current, file)))) fail('legacy_directory');
      if (dirname(current) === current) break;
    }
    this.dir = join(dataDir, 'media-core'); this.path = join(this.dir, 'manifest.json');
    this.now = now; this.lookup = lookup; this.request = request;
    createdByStore.set(this, new Map());
    assertRealDirectory(this.dir);
    if (existsSync(this.dir) && !existsSync(this.path) && readdirSync(this.dir).length) fail('unrecognized_directory', 500);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) writeFileSync(this.path, JSON.stringify({ format: FORMAT, assets: [] }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    this.readManifest(); this.usage();
  }

  readManifest() {
    try {
      assertRealDirectory(this.dir);
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MEDIA_LIMITS.manifest || !samePath(realpathSync(this.path), this.path)) fail('invalid_manifest', 500);
      const bytes = readFileSync(this.path);
      if (bytes.length > MEDIA_LIMITS.manifest) fail('invalid_manifest', 500);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!manifest || Object.keys(manifest).sort().join(',') !== 'assets,format' || manifest.format !== FORMAT || !Array.isArray(manifest.assets)) fail('invalid_manifest', 500);
      const ids = new Set();
      for (const record of manifest.assets) { validateRecord(record); if (ids.has(record.id)) fail('invalid_manifest', 500); ids.add(record.id); }
      return manifest;
    } catch (error) { if (error instanceof MediaError) throw error; fail('invalid_manifest', 500); }
  }

  usage() {
    assertRealDirectory(this.dir);
    let total = 0;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || !samePath(realpathSync(path), path)) fail('unsafe_asset', 500);
      total += stat.size;
      if (!Number.isSafeInteger(total)) fail('quota_exceeded', 429);
    }
    return total;
  }

  writeManifest(manifest) {
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (bytes.length > MEDIA_LIMITS.manifest) fail('manifest_full', 429);
    // Account for both the old manifest and its atomic replacement while writing.
    if (this.usage() + bytes.length > MEDIA_LIMITS.quota) fail('quota_exceeded', 429);
    const temp = join(this.dir, `.manifest-${randomUUID()}.tmp`); let fd;
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.path); }
    catch (error) { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); if (error instanceof MediaError) throw error; fail('save_failed', 500); }
  }

  get(id, owner = 'owner') { return this.resolveAsset(id, owner).meta; }

  resolveAsset(id, owner = 'owner') {
    owner = safeOwner(owner);
    if (typeof id !== 'string' || !ID.test(id)) fail('not_found', 404);
    const record = this.readManifest().assets.find(asset => asset.id === id && asset.owner === owner);
    if (!record) fail('not_found', 404);
    if (record.expiresAt <= this.now()) fail('expired', 410);
    const path = join(this.dir, id + '.bin');
    let fd;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== record.size || !samePath(realpathSync(path), path)) fail('unsafe_asset', 500);
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size !== record.size || opened.dev !== stat.dev || opened.ino !== stat.ino || !samePath(realpathSync(path), path)) fail('unsafe_asset', 500);
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let offset = 0, count;
      while ((count = readSync(fd, buffer, 0, buffer.length, offset))) { offset += count; if (offset > record.size) fail('asset_changed', 500); hash.update(buffer.subarray(0, count)); }
      if (offset !== record.size || hash.digest('hex') !== record.sha256) fail('asset_changed', 500);
    } catch (error) { if (error instanceof MediaError) throw error; fail('asset_unavailable', 500); }
    finally { if (fd !== undefined) closeSync(fd); }
    return { path, meta: publicMeta(record) };
  }

  readImage(id, owner = 'owner') {
    const { path, meta } = this.resolveAsset(id, owner);
    if (!IMAGE_TYPES.includes(meta.mimeType) || meta.size > MEDIA_LIMITS.image) fail('not_image');
    const bytes = readFileSync(path);
    if (bytes.length !== meta.size || createHash('sha256').update(bytes).digest('hex') !== meta.sha256 || sniffImage(bytes) !== meta.mimeType) fail('asset_changed', 500);
    return { type: 'image', data: bytes.toString('base64'), mimeType: meta.mimeType };
  }

  // Private ingress already possesses the original image bytes. No external URL,
  // CDN credential or decryption material is persisted or sent to the assistant.
  importBuffer({ bytes, mimeType, owner = 'owner', fileName = '微信照片' } = {}) {
    owner = safeOwner(owner);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail('invalid_image');
    if (bytes.length > MEDIA_LIMITS.image) fail('image_too_large', 413);
    if (typeof mimeType !== 'string' || !IMAGE_TYPES.includes(mimeType) || sniffImage(bytes) !== mimeType) fail('type_mismatch');
    if (typeof fileName !== 'string' || fileName.length > 1024) fail('invalid_metadata');
    if (transferActive) fail('busy', 429);
    transferActive = true;
    const temp = join(this.dir, `.import-${randomUUID()}.tmp`);
    let fd, destination, committed = false;
    try {
      const manifest = this.readManifest();
      if (this.usage() + bytes.length > MEDIA_LIMITS.quota) fail('quota_exceeded', 429);
      const id = 'media_' + randomBytes(16).toString('hex');
      const record = { id, kind: 'image', owner, mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fileName: cleanFileName(fileName, mimeType), expiresAt: this.now() + MEDIA_LIMITS.lifetime };
      destination = join(this.dir, id + '.bin');
      if (existsSync(destination)) fail('save_failed', 500);
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, destination); manifest.assets.push(record); this.writeManifest(manifest); committed = true;
      createdByStore.get(this).set(id, clone(record));
      return publicMeta(record);
    } catch (error) { if (error instanceof MediaError) throw error; fail('save_failed', 500); }
    finally {
      if (fd !== undefined) closeSync(fd);
      for (const path of [temp, !committed && destination].filter(Boolean)) {
        try { if (existsSync(path) && !lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch {}
      }
      transferActive = false;
    }
  }

  // Internal compensation for the caller's current failed operation; never expose as an MCP tool.
  rollbackCreated(ids, owner = 'owner') {
    owner = safeOwner(owner);
    if (!Array.isArray(ids) || ids.length > 32 || ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(ids).size !== ids.length) fail('invalid_rollback');
    if (!ids.length) return 0;
    const created = createdByStore.get(this), verified = [];
    // Validate every requested asset before changing the manifest or deleting any bytes.
    for (const id of ids) {
      const original = created.get(id);
      if (!original) fail('rollback_not_created', 409);
      if (original.owner !== owner) fail('rollback_not_owned', 403);
      const asset = this.resolveAsset(id, owner);
      if (JSON.stringify(asset.meta) !== JSON.stringify(publicMeta(original))) fail('asset_changed', 500);
      verified.push({ id, path: asset.path });
    }
    const manifest = this.readManifest(), wanted = new Set(ids);
    if (manifest.assets.filter(asset => wanted.has(asset.id) && asset.owner === owner).length !== ids.length) fail('asset_changed', 500);
    manifest.assets = manifest.assets.filter(asset => !wanted.has(asset.id));
    // Atomic logical removal comes first. Any physical leftovers remain visible to usage().
    this.writeManifest(manifest);
    for (const id of ids) created.delete(id);
    let removed = 0; const residueIds = [];
    for (const asset of verified) {
      try { unlinkSync(asset.path); removed++; }
      catch { residueIds.push(asset.id); }
    }
    if (residueIds.length) {
      const error = new MediaError('rollback_cleanup_incomplete', 500);
      error.removedCount = removed; error.recordsRemoved = ids.length; error.residueIds = residueIds;
      throw error;
    }
    return removed;
  }

  async ingest({ url, kind = 'image', owner = 'owner', fileName = '', mimeType = '' } = {}) {
    owner = safeOwner(owner);
    if (!['image', 'file'].includes(kind)) fail('invalid_kind');
    if (typeof fileName !== 'string' || fileName.length > 1024 || typeof mimeType !== 'string' || mimeType.length > 200) fail('invalid_metadata');
    const expectedMime = normalizeMime(mimeType);
    if (expectedMime && !(kind === 'image' ? IMAGE_TYPES : FILE_TYPES).includes(expectedMime)) fail('unsupported_type');
    if (transferActive) fail('busy', 429);
    transferActive = true;
    const controller = new AbortController(), temp = join(this.dir, `.download-${randomUUID()}.tmp`);
    let timer, transfer, destination, committed = false;
    try {
      return await Promise.race([
        (async () => {
          this.readManifest(); const usage = this.usage();
          if (usage >= MEDIA_LIMITS.quota) fail('quota_exceeded', 429);
          let target;
          try { target = await validateCallbackUrl(url, { lookup: this.lookup }); }
          catch (error) { if (error instanceof WebhookError) throw new MediaError(error.reason); throw error; }
          if (controller.signal.aborted) fail('timeout', 504);
          transfer = this.download(target, temp, { kind, expectedMime, usage, signal: controller.signal });
          const result = await transfer;
          if (controller.signal.aborted) fail('timeout', 504);
          const id = 'media_' + randomBytes(16).toString('hex'); destination = join(this.dir, id + '.bin');
          const record = { id, kind, owner, mimeType: result.mimeType, size: result.size, sha256: result.sha256, fileName: cleanFileName(fileName, result.mimeType), expiresAt: this.now() + MEDIA_LIMITS.lifetime };
          const manifest = this.readManifest(); manifest.assets.push(record);
          if (existsSync(destination)) fail('save_failed', 500);
          renameSync(temp, destination); this.writeManifest(manifest); committed = true;
          createdByStore.get(this).set(id, clone(record));
          return publicMeta(record);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MediaError('timeout', 504)); }, MEDIA_LIMITS.timeout); })
      ]);
    } catch (error) { if (error instanceof MediaError) throw error; fail(controller.signal.aborted ? 'timeout' : 'download_failed', controller.signal.aborted ? 504 : 502); }
    finally {
      clearTimeout(timer); controller.abort();
      if (transfer) { try { await transfer; } catch {} }
      try { if (existsSync(temp) && !lstatSync(temp).isSymbolicLink()) unlinkSync(temp); } catch {}
      try { if (!committed && destination && existsSync(destination) && !lstatSync(destination).isSymbolicLink()) unlinkSync(destination); } catch {}
      transferActive = false;
    }
  }

  download(target, temp, { kind, expectedMime, usage, signal }) {
    return new Promise((resolveDownload, rejectDownload) => {
      let request, response, writer, writerClosed = false, settled = false;
      const reject = error => {
        if (settled) return; settled = true;
        const safe = error instanceof MediaError ? error : new MediaError(signal.aborted ? 'timeout' : 'download_failed', signal.aborted ? 504 : 502);
        signal.removeEventListener('abort', abort);
        if (writer && !writerClosed) { writer.once('close', () => rejectDownload(safe)); writer.destroy(); }
        else rejectDownload(safe);
        if (response) response.destroy(); if (request) request.destroy();
      };
      const abort = () => reject(new MediaError('timeout', 504));
      signal.addEventListener('abort', abort, { once: true });
      try {
        request = this.request({ hostname: target.hostname, port: Number(target.url.port || 443), path: target.url.pathname + target.url.search, method: 'GET',
          servername: isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, agent: false, family: target.family, signal,
          lookup: (_hostname, _options, callback) => callback(null, target.pinnedAddress, target.family),
          headers: { Accept: kind === 'image' ? IMAGE_TYPES.join(', ') : FILE_TYPES.join(', '), 'Accept-Encoding': 'identity' } }, incoming => {
          response = incoming;
          response.on('error', reject);
          if (settled || signal.aborted) { response.destroy(); return; }
          try {
            if (response.statusCode >= 300 && response.statusCode < 400) fail('redirect');
            if (response.statusCode !== 200) fail('download_failed', 502);
            const type = normalizeMime(response.headers['content-type']);
            if (!(kind === 'image' ? IMAGE_TYPES : FILE_TYPES).includes(type) || expectedMime && type !== expectedMime) fail('unsupported_type');
            const encoding = response.headers['content-encoding'];
            if (encoding && encoding.toLowerCase() !== 'identity') fail('unsupported_encoding');
            const length = response.headers['content-length'];
            if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) fail('invalid_length');
            const max = IMAGE_TYPES.includes(type) ? Math.min(MEDIA_LIMITS[kind], MEDIA_LIMITS.image) : MEDIA_LIMITS[kind];
            if (length !== undefined && Number(length) > max) fail('too_large', 413);
            if (length !== undefined && usage + Number(length) >= MEDIA_LIMITS.quota) fail('quota_exceeded', 429);
            const hash = createHash('sha256'), decoder = type === 'text/plain' ? new TextDecoder('utf-8', { fatal: true }) : null;
            let size = 0, prefix = Buffer.alloc(0);
            const validateText = value => { if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(value)) fail('invalid_content'); };
            const checker = new Transform({ transform(chunk, _encoding, callback) {
              try {
                if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
                size += chunk.length;
                if (size > max) fail('too_large', 413);
                if (usage + size >= MEDIA_LIMITS.quota) fail('quota_exceeded', 429);
                if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
                if (decoder) { try { validateText(decoder.decode(chunk, { stream: true })); } catch { fail('invalid_content'); } }
                hash.update(chunk); callback(null, chunk);
              } catch (error) { callback(error); }
            }, flush(callback) {
              try {
                if (!size || length !== undefined && Number(length) !== size) fail('invalid_length');
                if (IMAGE_TYPES.includes(type) && sniffImage(prefix) !== type || type === 'application/pdf' && !prefix.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('invalid_content');
                if (decoder) { try { validateText(decoder.decode()); } catch { fail('invalid_content'); } }
                callback();
              } catch (error) { callback(error); }
            } });
            assertRealDirectory(this.dir); writer = createWriteStream(temp, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 });
            writer.on('close', () => { writerClosed = true; });
            pipeline(response, checker, writer).then(() => {
              if (settled) return; settled = true; signal.removeEventListener('abort', abort);
              resolveDownload({ mimeType: type, size, sha256: hash.digest('hex') });
            }, reject);
          } catch (error) { reject(error); }
        });
        request.on('error', reject); request.end();
        if (signal.aborted) abort();
      } catch (error) { reject(error); }
    });
  }
}
