import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WeixinChannel, WeixinError } from './lib/weixin.mjs';

export async function main(args = process.argv.slice(2)) {
  const command = args.shift();
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--state-dir', '--text-file', '--notification-id'].includes(args[i]) || !args[i + 1] || own(values, args[i])) throw new Error('invalid_arguments');
    values[args[i]] = args[i + 1];
  }
  if (!['login-start', 'login-check', 'context-check', 'status', 'send'].includes(command) || !values['--state-dir']) throw new Error('invalid_arguments');
  const channel = new WeixinChannel({ stateDir: values['--state-dir'] });
  let result;
  if (command === 'login-start') result = await channel.beginLogin();
  else if (command === 'login-check') result = await channel.pollLogin();
  else if (command === 'context-check') result = await channel.pollOwnerContext();
  else if (command === 'status') result = await channel.status();
  else {
    const file = values['--text-file'];
    if (!file || !values['--notification-id'] || !path.isAbsolute(file)) throw new Error('invalid_arguments');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32000) throw new Error('invalid_arguments');
    result = await channel.sendNotification({ notificationId: values['--notification-id'], text: fs.readFileSync(file, 'utf8') });
  }
  console.log(JSON.stringify({ ok: true, ...result }));
  if (['unknown', 'rejected'].includes(result.state)) process.exitCode = 2;
  return result;
}
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.log(JSON.stringify({ ok: false, error: error instanceof WeixinError ? error.code : 'invalid_arguments',
      message: error instanceof WeixinError ? error.message : '参数或文件不正确，未输出私密内容', ...(error instanceof WeixinError ? { diagnostics: error.diagnostics } : {}) }));
    process.exitCode = 1;
  });
}
