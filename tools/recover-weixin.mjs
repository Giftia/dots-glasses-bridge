import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {retryRejectedPart} from '../lib/weixin-recovery.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const utf8=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
function tree(directory){
 if(!path.isAbsolute(directory))fail('ABSOLUTE_PRIVATE_DIRECTORY_REQUIRED');
 for(let current=path.resolve(directory);;current=path.dirname(current)){
  const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_PRIVATE_DIRECTORY');
  if(path.dirname(current)===current)break;
 }
}
function bytes(file,max=4*1024*1024){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max)fail('UNSAFE_STATE_FILE');return fs.readFileSync(file);}
function atomic(file,value){
 bytes(file);const temporary=file+'.recovery-'+randomBytes(12).toString('hex')+'.tmp',data=JSON.stringify(value);
 const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,data,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temporary,file);
}
function exclusive(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export async function main(args=process.argv.slice(2)){
 const options={};for(let i=0;i<args.length;i++){
  const key=args[i];if(Object.hasOwn?Object.hasOwn(options,key):Object.prototype.hasOwnProperty.call(options,key))fail('DUPLICATE_ARGUMENT');
  if(['--apply','--allow-retry-rejected'].includes(key))options[key]=true;
  else if(['--relay-dir','--channel-dir','--runtime-root','--source-id','--updated-at'].includes(key)&&args[i+1])options[key]=args[++i];
  else fail('INVALID_ARGUMENT');
 }
 const relay=options['--relay-dir'],directory=options['--channel-dir'];tree(relay);tree(directory);
 const runtime=options['--runtime-root']||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');tree(runtime);
 const moduleFile=path.join(runtime,'lib/weixin.mjs');bytes(moduleFile);
 const {WeixinChannel}=await import(pathToFileURL(moduleFile).href),channel=new WeixinChannel({stateDir:directory});
 const planFile=path.join(relay,'outbound-plan.json'),accountFile=path.join(directory,'weixin-channel.json');
 const planBytes=bytes(planFile),account=JSON.parse(utf8(bytes(accountFile))),plan=JSON.parse(utf8(planBytes));
 const sourceId=options['--source-id'],updatedAt=Number(options['--updated-at']);
 const backupRoot=path.join(relay,'recovery-'+hash(String(sourceId)+':'+updatedAt).slice(0,24)),transactionFile=path.join(backupRoot,'RECOVERY-RECEIPT.json');
 let guard;
 const ensureOriginal=()=>{if(!bytes(planFile).equals(planBytes))fail('PLAN_CHANGED_REVIEW_REQUIRED');};
 const verifyUnchanged=async()=>{
  ensureOriginal();const current=JSON.parse(utf8(bytes(accountFile)));
  if(hash(JSON.stringify(current.binding))!==hash(JSON.stringify(account.binding)))fail('BOUND_OWNER_CHANGED');
  const id=sourceId+'-p'+(plan.nextPart+1);
  if(JSON.stringify(current.notifications[id])!==JSON.stringify(account.notifications[id]))fail('ORIGINAL_NATIVE_RECEIPT_CHANGED');
 };
 try{
  const result=await retryRejectedPart({plan,account,sourceId,updatedAt,apply:!!options['--apply'],allowRetryRejected:!!options['--allow-retry-rejected'],operations:{
   reserve:async receipt=>{
    // One recovery helper at a time. A stale reservation is reviewed, never stolen.
    guard=fs.openSync(path.join(relay,'recovery.lock'),'wx',0o600);
    fs.writeFileSync(guard,JSON.stringify({pid:process.pid}),'utf8');fs.fsyncSync(guard);
    if(fs.existsSync(backupRoot))fail('RECOVERY_TRANSACTION_ALREADY_EXISTS');
    fs.mkdirSync(backupRoot,{mode:0o700});exclusive(transactionFile,JSON.stringify(receipt));
   },
   backup:async(_plan,native,target)=>{
    exclusive(path.join(backupRoot,'outbound-plan.before.json'),planBytes);
    exclusive(path.join(backupRoot,'rejected-native.before.json'),JSON.stringify(native));
    const manifest=['# Backup Manifest: '+path.basename(backupRoot),'','- created_at: '+new Date().toISOString(),'- source_path: '+planFile,'- backup_dir: '+backupRoot,'- pre_backup_state: one exact explicitly rejected outbound part; live worker retains durable outbound pause','- included: original outbound-plan bytes and the single original rejected receipt; private transaction metadata','- excluded: account binding, context tokens, login, other native records, cursor, task configuration and application code','- verification: original plan SHA-256 '+hash(planBytes)+'; original native SHA-256 '+hash(JSON.stringify(native)),'- intended_use: compare and separately reviewed partial recovery only','- rollback_scope: original outbound plan only, while worker is stopped and after current receipts/cursor are reviewed','- not_restorable: any already accepted external message; do not roll back the cursor or erase the recovery native receipt','- pre_rollback_checks: same plan identity, no active consumer; concrete restore approval required','- rollback_steps: no automatic restore; never recreate stale locks or resend unknown outcomes','- post_rollback_verification: account and cursor unchanged, exact original rejected receipt retained','- remote_sync_status: stored only in executing private relay directory; operator must securely mirror this manifest if required',''];
    exclusive(path.join(backupRoot,'BACKUP-MANIFEST.md'),manifest.join('\n'));
    if(hash(bytes(path.join(backupRoot,'outbound-plan.before.json')))!==hash(planBytes))fail('BACKUP_VERIFICATION_FAILED');
   },
   verifyUnchanged,
   saveTransaction:async value=>atomic(transactionFile,value),
   send:async value=>{
    const deadline=Date.now()+45000;
    for(;;){
     await verifyUnchanged();
     const current=JSON.parse(utf8(bytes(accountFile)));
     const contextAt=current.context?.receivedAt;
     if(!Number.isSafeInteger(contextAt)||contextAt<=updatedAt||contextAt>Date.now()||Date.now()-contextAt>600000)fail('FRESH_OWNER_MESSAGE_REQUIRED');
     try{return await channel.sendNotification(value);}catch(error){if(error.code!=='busy'||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,500));}
    }
   },
   savePlan:async value=>{ensureOriginal();atomic(planFile,value);},
  }});
  return {...result,...(options['--apply']?{backupManifest:path.join(backupRoot,'BACKUP-MANIFEST.md')}:{})};
 }finally{if(guard!==undefined){fs.closeSync(guard);fs.unlinkSync(path.join(relay,'recovery.lock'));}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{
  const code=/^[A-Z][A-Z0-9_]{2,90}$/.test(error.code||'')?error.code:'RECOVERY_NEEDS_REVIEW';
  console.log(JSON.stringify({status:'needs-attention',error:code,noAutomaticRetry:true,taskRestarted:false}));process.exitCode=1;
 });
}
