import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {WeixinChannel} from './lib/weixin.mjs';
import {validateConnection,forwardBatch,fetchFeed} from './lib/weixin-forwarder.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
function regular(file,max=8192){
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)fail('UNSAFE_STATE_FILE');
  return fs.readFileSync(file,'utf8');
}
function tree(directory){
  if(!path.isAbsolute(directory))fail('ABSOLUTE_DIRECTORY_REQUIRED');
  for(let current=path.resolve(directory);;current=path.dirname(current)){
    const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_STATE_DIRECTORY');
    if(path.dirname(current)===current)break;
  }
}
export function atomic(file,value,maxBytes=8192){
  if(fs.existsSync(file))regular(file,maxBytes);
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)fail('STATE_FILE_LIMIT');
  const tmp=path.join(path.dirname(file),'.relay-'+randomBytes(12).toString('hex')+'.tmp');
  const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);
}
function acquire(directory){
  const file=path.join(directory,'relay.lock'),nonce=randomBytes(16).toString('hex');
  for(let tries=0;tries<2;tries++){
    try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});return ()=>{if(JSON.parse(regular(file)).nonce===nonce)fs.unlinkSync(file);};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const old=JSON.parse(regular(file));if(!Number.isSafeInteger(old.pid)||old.pid<1)fail('RELAY_BUSY');
      try{process.kill(old.pid,0);fail('RELAY_BUSY');}catch(probe){if(probe.code!=='ESRCH')fail('RELAY_BUSY');}
      fail('STALE_RELAY_LOCK');
    }
  }
  fail('RELAY_BUSY');
}
const RETRY_DELAYS=[15000,30000,60000,120000,300000];
export function waitForWatch(milliseconds,signal){
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,milliseconds);
    signal.addEventListener('abort',done,{once:true});
    if(signal.aborted)done();
  });
}
export async function runForwardingLoop({command,connection,channel,cursor=connection.after,saveCursor,saveReceipt,fetch=fetchFeed,now=Date.now,wait=waitForWatch,signals=process,onAccepted=()=>{}}){
  if(!['once','watch'].includes(command))fail('INVALID_COMMAND');
  const controller=new AbortController(),stop=()=>controller.abort();
  signals.on('SIGINT',stop);signals.on('SIGTERM',stop);
  let failures=0;
  try{
    while(!controller.signal.aborted){
      const deadline=now()+55000;let result,feedFailure;
      // Only this read-only fetch can authorize a retry. A same-named error
      // from a sender, cursor save or receipt save must still stop the loop.
      const guardedFetch=async(...args)=>{
        try{return await fetch(...args);}catch(error){
          if(error&&['FEED_NETWORK_ERROR','FEED_TIMEOUT'].includes(error.code))feedFailure=error;
          throw error;
        }
      };
      try{
        result=await forwardBatch({connection,channel,cursor,fetch:guardedFetch,budgetRemaining:()=>deadline-now(),saveCursor:async value=>{await saveCursor(value);cursor=value;}});
      }catch(error){
        if(command!=='watch'||error!==feedFailure)throw error;
        if(controller.signal.aborted)return {state:'stopped'};
        failures=Math.min(failures+1,Number.MAX_SAFE_INTEGER);
        const delay=RETRY_DELAYS[Math.min(failures-1,RETRY_DELAYS.length-1)];
        await saveReceipt({format:'dots-weixin-forwarding-receipt-v1',checkedAt:new Date(now()).toISOString(),state:'feed_retry_wait',error:feedFailure.code,consecutiveFailures:failures,nextWaitMilliseconds:delay});
        await wait(delay,controller.signal);
        continue;
      }
      failures=0;
      await saveReceipt({format:'dots-weixin-forwarding-receipt-v1',checkedAt:new Date(now()).toISOString(),...result,consecutiveFailures:0});
      if(command==='once')return result;
      if(!['idle','forwarded','budget_exhausted'].includes(result.state))return result;
      if(result.accepted)onAccepted(result);
      if(!controller.signal.aborted)await wait(15000,controller.signal);
    }
    return {state:'stopped'};
  }finally{signals.off('SIGINT',stop);signals.off('SIGTERM',stop);}
}
export async function main(args=process.argv.slice(2)){
  const [command,stateDir,channelDir,importPath]=args;
  if(!['once','watch','watch-chat','import','status'].includes(command)||args.length!==(command==='import'?4:3))fail('INVALID_COMMAND');
  tree(stateDir);tree(channelDir);
  const release=acquire(stateDir);
  try{
    const configFile=path.join(stateDir,'connection.json');
    if(command==='import'){
      const connection=validateConnection(JSON.parse(regular(importPath)));
      if(fs.existsSync(configFile)){
        if(JSON.stringify(validateConnection(JSON.parse(regular(configFile))))!==JSON.stringify(connection))fail('CONNECTION_ALREADY_EXISTS');
      }else{fs.writeFileSync(configFile,JSON.stringify(connection),{flag:'wx',mode:0o600});}
      return {state:'connection_imported',baseUrl:connection.baseUrl,credentialsMoved:false};
    }
    const connection=validateConnection(JSON.parse(regular(configFile))),channel=new WeixinChannel({stateDir:channelDir});
    const fingerprint=createHash('sha256').update(JSON.stringify(connection)).digest('hex');
    const cursorFile=path.join(stateDir,'cursor.json');let cursor=connection.after;
    if(fs.existsSync(cursorFile)){
      const old=JSON.parse(regular(cursorFile));if(old.format!=='dots-weixin-cursor-v1'||old.connection!==fingerprint||typeof old.cursor!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(old.cursor))fail('INVALID_CURSOR_STATE');
      cursor=old.cursor;
    }
    if(command==='status')return {state:'configured',channel:await channel.status(),cursorSaved:!!cursor,baseUrl:connection.baseUrl};
    if(command==='watch-chat'){
      const {validateInboundConnection,runDuplexLoop}=await import('./lib/weixin-duplex.mjs');
      const {downloadWeixinImage}=await import('./lib/weixin-media.mjs');
      const inbound=validateInboundConnection(JSON.parse(regular(path.join(stateDir,'inbound-connection.json'))));
      if(inbound.baseUrl!==connection.baseUrl||inbound.token===connection.token)fail('INBOUND_CONNECTION_MUST_BE_SEPARATE');
      const planFile=path.join(stateDir,'outbound-plan.json');
      return await runDuplexLoop({connection:inbound,channel,cursor,
        loadPlan:()=>fs.existsSync(planFile)?JSON.parse(regular(planFile,512*1024)):null,
        savePlan:value=>atomic(planFile,value,512*1024),
        saveCursor:value=>atomic(cursorFile,{format:'dots-weixin-cursor-v1',connection:fingerprint,cursor:value}),
        saveReceipt:value=>atomic(path.join(stateDir,'receipt.json'),value),
        downloadImage:image=>downloadWeixinImage(image,{directory:channelDir}),
        onAccepted:result=>console.log(JSON.stringify({state:result.state,accepted:result.accepted,duplex:true}))});
    }
    return await runForwardingLoop({command,connection,channel,cursor,
      saveCursor:value=>atomic(cursorFile,{format:'dots-weixin-cursor-v1',connection:fingerprint,cursor:value}),
      saveReceipt:value=>atomic(path.join(stateDir,'receipt.json'),value),
      onAccepted:result=>console.log(JSON.stringify({state:result.state,accepted:result.accepted}))});
  }finally{release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().then(result=>{console.log(JSON.stringify({ok:true,...result}));if(!['idle','forwarded','stopped','connection_imported','configured'].includes(result.state))process.exitCode=2;}).catch(error=>{console.log(JSON.stringify({ok:false,error:/^[A-Za-z][A-Za-z0-9_]{1,80}$/.test(error.code||'')?error.code:'RELAY_OPERATION_FAILED'}));process.exitCode=1;});
}
