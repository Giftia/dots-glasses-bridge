import { lstatSync, readFileSync, mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { restrictDirectory } from './init.mjs';
import { validateConnection } from '../lib/weixin-forwarder.mjs';
import { validateInboundConnection } from '../lib/weixin-duplex.mjs';

const fail = message => { throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function stat(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directoryTree(path) {
  for (let current = path; ; current = dirname(current)) {
    const info = stat(current);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) fail('Configuration and data ancestors must be existing real directories.');
    if (dirname(current) === current) break;
  }
}
function regular(path, maxBytes) {
  directoryTree(dirname(path));
  const info = stat(path);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) fail('Configuration or event state file is missing or unsafe.');
  return readFileSync(path);
}
function json(bytes) { try { const value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { fail('Configuration or event state JSON is invalid.'); } }
function create(path, bytes) { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }

/** Offline one-time configuration update. Never starts or restarts a service. */
export function initializeWeixin(configPath) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) fail('An absolute configuration file path is required.');
  configPath = resolve(configPath);
  const original = regular(configPath, 256 * 1024), config = json(original);
  if (Object.prototype.hasOwnProperty.call(config, 'weixinRelayToken') || Object.prototype.hasOwnProperty.call(config, 'weixinIngressToken')) fail('Weixin configuration already exists or is partial; refusing to overwrite.');
  if (typeof config.platformToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(config.platformToken) || typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) fail('Existing bridge credentials or data directory are invalid.');
  directoryTree(config.dataDir);
  const setupDir = join(dirname(configPath), 'weixin-setup');
  if (stat(setupDir)) fail('Weixin setup directory already exists or is partial; refusing to overwrite.');
  const coreDir = join(config.dataDir, 'event-core');
  let sequence = 0;
  if (stat(coreDir)) {
    directoryTree(coreDir);
    const statePath = join(coreDir, 'state.json');
    if (stat(statePath)) {
      const state = json(regular(statePath, 64 * 1024 * 1024));
      if (state.notificationSequence !== undefined) sequence = state.notificationSequence;
      else if ((state.tasks || []).length || (state.notifications || []).length) fail('notificationSequence is absent from nonempty state; review migration instead of replaying history.');
    }
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail('notificationSequence must be a nonnegative safe integer.');
  const tokens = new Set([config.platformToken]);
  const freshToken = () => { let token; do { token = randomBytes(32).toString('base64url'); } while (tokens.has(token)); tokens.add(token); return token; };
  const relayToken = freshToken(), ingressToken = freshToken(), now = Date.now();
  const connection = validateConnection({ format: 'dots-weixin-relay-connection-v1', baseUrl: config.publicBaseUrl, since: now, token: relayToken, after: Buffer.from(JSON.stringify(sequence)).toString('base64url') });
  const inbound = validateInboundConnection({ format: 'dots-weixin-inbound-v1', baseUrl: config.publicBaseUrl, token: ingressToken, activatedAt: now });
  // The new directory is restricted before the first credential/backup write.
  mkdirSync(setupDir, { mode: 0o700 }); restrictDirectory(setupDir);
  const backupPath = join(setupDir, 'config.before.json'), manifestPath = join(setupDir, 'BACKUP-MANIFEST.md');
  const connectionPath = join(setupDir, 'connection.json'), inboundPath = join(setupDir, 'inbound-connection.json');
  create(backupPath, original);
  const manifest = [
    '# Backup Manifest: optional-weixin-setup', '',
    '- created_at: ' + new Date(now).toISOString(),
    '- source_path: ' + configPath,
    '- backup_dir: ' + setupDir,
    '- backup_path: ' + backupPath,
    '- backup_type: config-snapshot',
    '- pre_backup_state: offline setup requested; actual stopped service state must be checked by the operator',
    '- included: exact original configuration bytes; these contain credentials and must stay private',
    '- excluded: task data, photos, OAuth state, WeChat login, account context, relay cursors and process state',
    '- verification: SHA-256 ' + sha256(original) + '; ' + original.length + ' bytes',
    '- intended_use: compare and separately reviewed partial restore',
    '- rollback_scope: this configuration file only; does not retract remote sends or restore account data',
    '- not_restorable: process memory, external account state or accepted messages',
    '- pre_rollback_checks: stop the single application; review current configuration/hash and obtain concrete restore approval',
    '- rollback_steps: restore only verified original configuration bytes; no automatic rollback or restart',
    '- post_rollback_verification: same application identity, intended tokens and expected health; separately authorize any restart',
    '- sensitive_data_policy: never publish the backup bytes, connection files or owner code',
    '- remote_sync_status: manifest stored on executing host; secure local-library mirroring is operator responsibility', ''
  ].join('\n');
  create(manifestPath, manifest);
  if (sha256(regular(backupPath, 256 * 1024)) !== sha256(original)) fail('Original configuration backup could not be verified.');
  create(connectionPath, JSON.stringify(connection, null, 2) + '\n');
  create(inboundPath, JSON.stringify(inbound, null, 2) + '\n');
  // Recheck before replacing; a concurrent edit is preserved and setup stays partial.
  if (!regular(configPath, 256 * 1024).equals(original)) fail('Configuration changed during setup; private partial setup retained, no overwrite.');
  const temporaryPath = join(setupDir, 'config.updated.tmp');
  const fd = openSync(temporaryPath, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ ...config, weixinRelayToken: relayToken, weixinIngressToken: ingressToken }, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporaryPath, configPath);
  return { configPath, setupDir, backupPath, manifestPath, connectionPath, inboundPath, restartRequired: true, notificationSequence: sequence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') fail('Usage: node deploy/init-weixin.mjs --config ABSOLUTE_CONFIG_FILE');
    console.log(JSON.stringify(initializeWeixin(process.argv[3]), null, 2));
  } catch { console.error('Weixin initialization failed; inspect the existing configuration and any private partial weixin-setup directory. No credentials were printed.'); process.exitCode = 1; }
}
