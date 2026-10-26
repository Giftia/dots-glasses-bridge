import { lstatSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hashOwnerCode } from '../lib/oauth.mjs';

function status(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function validateOptions({ installDir, publicBaseUrl, port = 17326 } = {}) {
  if (typeof installDir !== 'string' || !isAbsolute(installDir)) throw new Error('A dedicated absolute installation directory is required.');
  installDir = resolve(installDir);
  if (installDir === parse(installDir).root) throw new Error('A filesystem root cannot be the installation directory.');
  for (let path = installDir; ; path = dirname(path)) {
    const info = status(path);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error('Installation ancestors must be real existing directories.');
    if (dirname(path) === path) break;
  }
  let url;
  try { url = new URL(publicBaseUrl); } catch { throw new Error('publicBaseUrl must be an HTTPS URL ending in /dots.'); }
  if (typeof publicBaseUrl !== 'string' || url.protocol !== 'https:' || url.username || url.password || publicBaseUrl.includes('?') || publicBaseUrl.includes('#') || url.pathname !== '/dots' || publicBaseUrl !== url.href) throw new Error('publicBaseUrl must be an exact HTTPS URL ending in /dots without credentials, query or fragment.');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  return { installDir, publicBaseUrl, port };
}

export function restrictDirectory(path) {
  if (readdirSync(path).length !== 0) throw new Error('Permission initialization requires a newly created empty directory.');
  if (process.platform !== 'win32') { chmodSync(path, 0o700); return; }
  try {
    const script = readFileSync(new URL('./private-directory.ps1', import.meta.url), 'utf8');
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, shell: false, stdio: 'pipe', timeout: 10000,
      env: { ...process.env, DOTS_NEW_DIRECTORY: path }
    });
  } catch { throw new Error('Cannot restrict the new runtime directory to the current user and SYSTEM; initialization stopped before writing secrets.'); }
}
/** Create a fresh private runtime. Existing or partial runtime is never replaced. */
export function initialize(options) {
  const { installDir, publicBaseUrl, port } = validateOptions(options);
  const runtimeRoot = join(installDir, '.dot-events');
  if (status(runtimeRoot)) throw new Error('Runtime already exists; initialization will not overwrite it.');
  // Exclusive mkdir also rejects an installation created concurrently.
  mkdirSync(runtimeRoot, { mode: 0o700 });
  restrictDirectory(runtimeRoot);
  const privateDir = join(runtimeRoot, 'private'), dataDir = join(runtimeRoot, 'data');
  mkdirSync(privateDir, { mode: 0o700 }); mkdirSync(dataDir, { mode: 0o700 });
  if (process.platform !== 'win32') { chmodSync(privateDir, 0o700); chmodSync(dataDir, 0o700); }
  const ownerCode = randomBytes(32).toString('base64url');
  let platformToken;
  do { platformToken = randomBytes(32).toString('base64url'); } while (platformToken === ownerCode);
  const configPath = join(privateDir, 'config.json'), ownerCodePath = join(privateDir, 'owner-code.txt'), manifestPath = join(privateDir, 'installation.json');
  const config = { publicBaseUrl, dataDir, ownerCodeHash: hashOwnerCode(ownerCode), platformToken, listenHost: '127.0.0.1', port };
  const metadata = { format: 'dots-deployment-v1', installationId: randomUUID(), installDir, runtimeRoot, privateDir, dataDir, configPath, ownerCodePath, manifestPath, publicBaseUrl, listenHost: '127.0.0.1', port, createdAt: new Date().toISOString() };
  for (const [path, body] of [[configPath, JSON.stringify(config, null, 2)], [ownerCodePath, ownerCode], [manifestPath, JSON.stringify(metadata, null, 2)]]) {
    writeFileSync(path, body + '\n', { flag: 'wx', mode: 0o600, encoding: 'utf8' });
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
  return metadata;
}

export function parseArguments(args) {
  const options = {}, names = { '--install-dir': 'installDir', '--public-base-url': 'publicBaseUrl', '--port': 'port' };
  for (let index = 0; index < args.length; index++) {
    const key = names[args[index]], value = args[++index];
    if (!key || value === undefined || Object.prototype.hasOwnProperty.call(options, key)) throw new Error('Usage: node deploy/init.mjs --install-dir ABS --public-base-url https://owner.example/dots [--port 17326]');
    if (key === 'port' && !/^[0-9]+$/.test(value)) throw new Error('Port must be an integer from 1 to 65535.');
    options[key] = key === 'port' ? Number(value) : value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(initialize(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
