import fs from 'node:fs';
import https from 'node:https';
import {createHash} from 'node:crypto';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=value=>createHash('sha256').update(value).digest('hex');
export function validateInboundConnection(value){
 if(!value||value.format!=='dots-weixin-inbound-v1'||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(value.token)||!Number.isSafeInteger(value.activatedAt)||value.activatedAt<1)fail('INVALID_INBOUND_CONNECTION');
 let url;try{url=new URL(value.baseUrl);}catch{fail('INVALID_INBOUND_CONNECTION');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/dots'||url.search||url.hash)fail('INVALID_INBOUND_CONNECTION');
 return {format:value.format,baseUrl:url.origin+'/dots',token:value.token,activatedAt:value.activatedAt};
}
export function bridgeRequest(connection,path,{body,maxBytes=1024*1024}={}){
 const config=validateInboundConnection(connection),url=new URL(config.baseUrl+path);
 if(url.origin!==new URL(config.baseUrl).origin||!url.pathname.startsWith('/dots/weixin/'))fail('INVALID_BRIDGE_PATH');
 const payload=body===undefined?undefined:JSON.stringify(body);
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
  const req=https.request(url,{method:payload===undefined?'GET':'POST',agent:false,headers:{Authorization:'Bearer '+config.token,...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)})}},res=>{
   const chunks=[];let size=0;
   if(res.statusCode!==200){res.resume();finish(Object.assign(new Error('BRIDGE_HTTP_ERROR'),{code:'BRIDGE_HTTP_ERROR',status:res.statusCode}));return;}
   res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){finish(Object.assign(new Error('BRIDGE_RESPONSE_LIMIT'),{code:'BRIDGE_RESPONSE_LIMIT'}));res.destroy();req.destroy();}else chunks.push(chunk);});
   res.on('error',()=>finish(Object.assign(new Error('BRIDGE_NETWORK_ERROR'),{code:'BRIDGE_NETWORK_ERROR'})));
   res.on('end',()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(Object.assign(new Error('INVALID_BRIDGE_RESPONSE'),{code:'INVALID_BRIDGE_RESPONSE'}));}});
  });
  timer=setTimeout(()=>{finish(Object.assign(new Error('BRIDGE_TIMEOUT'),{code:'BRIDGE_TIMEOUT'}));req.destroy();},15000);
  req.on('error',()=>finish(Object.assign(new Error('BRIDGE_NETWORK_ERROR'),{code:'BRIDGE_NETWORK_ERROR'})));req.end(payload);
 });
}
export function validateFullFeed(feed){
 if(!feed||feed.format!=='dots-weixin-outbox-v2'||!Array.isArray(feed.items)||feed.items.length>5||typeof feed.hasMore!=='boolean')fail('INVALID_FULL_FEED');
 const ids=new Set();let previous=-1;
 for(const item of feed.items){
  if(!item||!/^dots-[a-f0-9]{64}$/.test(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>40000||!Number.isSafeInteger(item.sequence)||item.sequence<=previous||!Number.isSafeInteger(item.createdAt)||item.createdAt<0||typeof item.cursor!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(item.cursor)||ids.has(item.id)||typeof item.hasFiles!=='boolean'||(item.taskId!==null&&(typeof item.taskId!=='string'||!/^QG-[a-f0-9]{12}$/.test(item.taskId)))||(item.replyId!==null&&(typeof item.replyId!=='string'||!item.replyId.trim()||item.replyId.length>128)))fail('INVALID_FULL_FEED');
  let seq;try{seq=JSON.parse(Buffer.from(item.cursor,'base64url').toString('utf8'));}catch{fail('INVALID_FULL_FEED');}
  if(seq!==item.sequence||Buffer.from(JSON.stringify(seq)).toString('base64url')!==item.cursor)fail('INVALID_FULL_FEED');
  previous=item.sequence;ids.add(item.id);
 }
 return feed;
}
export function splitWeixinText(text,limit=4000){
 if(typeof text!=='string'||!text.trim()||text.length>48000||!Number.isInteger(limit)||limit<2||limit>4000)fail('INVALID_OUTBOUND_TEXT');
 const parts=[];let offset=0;
 while(offset<text.length){
  let end=Math.min(offset+limit,text.length);
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
  if(end<text.length){const line=text.lastIndexOf('\n',end-1);if(line>=offset+Math.floor(limit/2))end=line+1;}
  parts.push(text.slice(offset,end));offset=end;
 }
 return parts;
}
const nativeBlockStates=new Set(['rejected','unknown']);
const nativeBlockReasons=new Set(['interrupted','untrusted_host','network_error','timeout','response_too_large','invalid_response','unsafe_message_id','http_error','remote_rejected']);
function nativeBlock(receipt){
 if(!receipt||!nativeBlockStates.has(receipt.state))fail('INVALID_NATIVE_SEND_RECEIPT');
 const value={state:receipt.state};
 if(nativeBlockReasons.has(receipt.reason))value.reason=receipt.reason;
 const diagnostics={};
 if(Number.isInteger(receipt.diagnostics?.httpStatus)&&receipt.diagnostics.httpStatus>=100&&receipt.diagnostics.httpStatus<=599)diagnostics.httpStatus=receipt.diagnostics.httpStatus;
 for(const key of ['ret','errcode'])if(Number.isSafeInteger(receipt.diagnostics?.[key])&&Math.abs(receipt.diagnostics[key])<=2147483648)diagnostics[key]=receipt.diagnostics[key];
 if(Object.keys(diagnostics).length)value.diagnostics=diagnostics;
 return value;
}
function blockedOutput(block,accepted=0){return {state:block.state,accepted,attentionRequired:true,outboundBlocked:true,nativeState:block.state,...(block.reason?{nativeReason:block.reason}:{}),...(block.diagnostics?{nativeDiagnostics:block.diagnostics}:{})};}
function checkPlan(plan,binding){
 if(plan&&(plan.format!=='dots-weixin-outbound-plan-v1'||plan.connection!==binding||!Array.isArray(plan.parts)||plan.parts.length<1||plan.parts.length>20||plan.parts.some(part=>typeof part!=='string'||!part.length||part.length>4000)||plan.contentHash!==hash(plan.parts.join(''))||!Number.isInteger(plan.nextPart)||plan.nextPart<0||plan.nextPart>plan.parts.length))fail('INVALID_OUTBOUND_PLAN');
 if(plan?.blocked){
  if(JSON.stringify(nativeBlock(plan.blocked))!==JSON.stringify(plan.blocked)||!/^dots-[a-f0-9]{64}$/.test(plan.sourceId)||typeof plan.sourceCursor!=='string'||plan.completed===true||plan.nextPart===plan.parts.length)fail('INVALID_OUTBOUND_PLAN');
 }
}
export async function forwardFullBatch({connection,channel,cursor,loadPlan,savePlan,saveCursor,request=bridgeRequest,budgetRemaining=()=>Infinity}){
 const cfg=validateInboundConnection(connection),binding=hash(JSON.stringify(cfg)),held=await loadPlan();
 checkPlan(held,binding);
 // A native rejection/unknown is a durable outbound pause, not a reason to
 // stop the single inbound consumer or to try the same delivery again.
 if(held?.blocked)return blockedOutput(held.blocked);
 const feed=validateFullFeed(await request(cfg,'/weixin/outbox?format=full-v1&after='+encodeURIComponent(cursor)));
 let cursorSequence;try{cursorSequence=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail('INVALID_OUTBOUND_CURSOR');}
 if(!Number.isSafeInteger(cursorSequence)||cursorSequence<0||Buffer.from(JSON.stringify(cursorSequence)).toString('base64url')!==cursor||feed.items.some(item=>item.sequence<=cursorSequence))fail('INVALID_OUTBOUND_CURSOR');
 let accepted=0;
 for(const item of feed.items){
  if(budgetRemaining()<16000)return {state:'budget_exhausted',accepted,hasMore:true};
  const fingerprint=hash(JSON.stringify([item.id,item.text,item.cursor,item.taskId,item.replyId,item.hasFiles]));
  let plan=await loadPlan();
  checkPlan(plan,binding);
  if(plan?.blocked)return blockedOutput(plan.blocked,accepted);
  if(plan&&plan.sourceId!==item.id){
   if(plan.completed!==true&&plan.sourceCursor===cursor&&Array.isArray(plan.parts)&&plan.nextPart===plan.parts.length){plan.completed=true;await savePlan(plan);}
   if(plan.completed!==true)fail('UNSETTLED_OUTBOUND_PLAN');
   plan=null;
  }
  if(plan){
   if(plan.format!=='dots-weixin-outbound-plan-v1'||plan.connection!==binding||plan.fingerprint!==fingerprint||plan.sourceCursor!==item.cursor||!Array.isArray(plan.parts)||plan.parts.length<1||plan.parts.length>20||plan.parts.some(x=>typeof x!=='string'||!x.length||x.length>4000)||plan.contentHash!==hash(plan.parts.join(''))||!Number.isInteger(plan.nextPart)||plan.nextPart<0||plan.nextPart>plan.parts.length)fail('INVALID_OUTBOUND_PLAN');
  }else{
   let text=item.text;
   if(item.hasFiles){
    if(!item.taskId)fail('INVALID_FULL_FEED');
    const result=await request(cfg,'/weixin/result?task_id='+encodeURIComponent(item.taskId)+(item.replyId?'&reply_id='+encodeURIComponent(item.replyId):''));
    if(result.task_id!==item.taskId||result.state!=='replied'||(item.replyId&&result.reply_id!==item.replyId))fail('INVALID_RESULT_REFERENCE');
    if(result.resultUrl){
     let url;try{url=new URL(result.resultUrl);}catch{fail('INVALID_RESULT_REFERENCE');}
     if(url.origin!==new URL(cfg.baseUrl).origin||url.pathname!=='/dots/results/'+item.taskId||url.username||url.password||url.hash||url.searchParams.get('task')!==item.taskId||(item.replyId&&url.searchParams.get('reply')!==item.replyId)||[...url.searchParams.keys()].sort().join(',')!==(item.replyId?'expires,reply,sig,task':'expires,sig,task')||!/^\d{1,16}$/.test(url.searchParams.get('expires')||'')||Number(url.searchParams.get('expires'))!==result.resultExpiresAt||!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('sig')||''))fail('INVALID_RESULT_REFERENCE');
     text+='\n\n查看完整图文：\n'+url.href;
    }else text+='\n\n附件链接已过期，请告诉 Dots 重新提供。';
   }
   plan={format:'dots-weixin-outbound-plan-v1',connection:binding,sourceId:item.id,sourceCursor:item.cursor,fingerprint,parts:splitWeixinText(text),contentHash:hash(text),nextPart:0,completed:false};
   await savePlan(plan);
  }
  for(let i=plan.nextPart;i<plan.parts.length;i++){
   if(budgetRemaining()<16000)return {state:'budget_exhausted',accepted,hasMore:true};
   const receipt=await channel.sendNotification({notificationId:item.id+'-p'+(i+1),text:plan.parts[i]});
   if(receipt.state!=='accepted'){
    if(nativeBlockStates.has(receipt.state)){plan.blocked=nativeBlock(receipt);await savePlan(plan);return blockedOutput(plan.blocked,accepted);}
    return {state:receipt.state,accepted,attentionRequired:true};
   }
   plan.nextPart=i+1;await savePlan(plan);
  }
  await saveCursor(item.cursor);cursor=item.cursor;plan.completed=true;await savePlan(plan);accepted++;
 }
 return {state:accepted?'forwarded':'idle',accepted,hasMore:feed.hasMore};
}
const terminalImageErrors=new Set(['invalid_image','invalid_url','invalid_key','too_large','invalid_content','decrypt_failed','non_public_address','redirect','unsupported_encoding','invalid_length','media_expired','media_rejected']);
const photoInstruction='我从微信发来一张照片，请结合我们的会话查看；如果用途不明确，请先问我。';
export async function submitOwnerInbox({connection,channel,downloadImage,request=bridgeRequest,onSubmitted=()=>{}}){
 const cfg=validateInboundConnection(connection),items=await channel.peekOwnerMessages({limit:1});
 if(!items.length)return {state:'idle',submitted:0};
 const item=items[0];let imageFile;
 const commit=async body=>{
  const result=await request(cfg,'/weixin/inbox',{body,maxBytes:16384});
  if(!result||!/^QG-[a-f0-9]{12}$/.test(result.task_id)||!['queued','notified','processing','replied'].includes(result.state)||typeof result.deduplicated!=='boolean')fail('INVALID_INBOX_RECEIPT');
  await channel.ackOwnerMessage({messageId:item.messageId});onSubmitted();return {state:'submitted',submitted:1};
 };
 const report=async()=>{
  if(typeof item.messageId!=='string'||!item.messageId||item.messageId.length>256||typeof item.text!=='string'||item.text.length>12000)fail('INVALID_INBOX_ITEM');
  const validRequestId=typeof item.requestId==='string'&&/^weixin-[a-f0-9]{64}$/.test(item.requestId);
  const request_id=validRequestId?item.requestId:'weixin-'+hash(JSON.stringify(['weixin-input-error-v1',item.messageId]));
  // A missing/invalid original message ID is only a local error key. Do not
  // turn its otherwise unverified payload into an instruction for the Dot.
  const message=validRequestId?(item.text.trim()?item.text:photoInstruction):'微信消息或附件未能完整读取，未获得可识别原图。请向用户说明情况，并请用户重新发送文字或一张不超过 4 MiB 的 JPG、PNG、WebP 照片。';
  return commit({request_id,message,input_error:'unavailable_attachment'});
 };
 if(item.error)return report();
 if(!/^weixin-[a-f0-9]{64}$/.test(item.requestId)||typeof item.text!=='string'||item.text.length>12000)fail('INVALID_INBOX_ITEM');
 try{
  if(item.image)imageFile=await downloadImage(item.image);
  const message=item.text.trim()?item.text:photoInstruction;
  const image=imageFile?{mime_type:imageFile.mimeType,base64:fs.readFileSync(imageFile.path).toString('base64')}:undefined;
  return await commit({request_id:item.requestId,message,...(image?{image}:{})});
 }catch(error){if(terminalImageErrors.has(error.code||error.reason))return report();throw error;}
 finally{if(imageFile)await imageFile.cleanup();}
}

export async function runDuplexLoop({connection,channel,cursor,loadPlan,savePlan,saveCursor,saveReceipt,downloadImage,request=bridgeRequest,signals=process,now=Date.now,wait,stopRequested=()=>false,onAccepted=()=>{}}){
 const cfg=validateInboundConnection(connection),controller=new AbortController(),stop=()=>controller.abort();
 const pause=wait||((ms,signal)=>new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();}));
 signals.on('SIGINT',stop);signals.on('SIGTERM',stop);let failures=0;
 const receipt=value=>saveReceipt({format:'dots-weixin-forwarding-receipt-v1',checkedAt:new Date(now()).toISOString(),duplex:true,...value});
 try{
  await receipt({state:'starting',accepted:0,inboundSubmitted:0});
  while(!controller.signal.aborted&&!await stopRequested()){
   let retryable,stage='inbound',submitted=0;
   const guardedRequest=async(...args)=>{try{return await request(...args);}catch(error){if(['BRIDGE_NETWORK_ERROR','BRIDGE_TIMEOUT'].includes(error?.code)||(error?.code==='BRIDGE_HTTP_ERROR'&&(error.status>=500||error.status===429)))retryable=error;throw error;}};
   const guardedDownload=async(...args)=>{try{return await downloadImage(...args);}catch(error){if(['timeout','dns_failed','download_failed','http_retryable'].includes(error?.code))retryable=error;throw error;}};
   const inbox=()=>submitOwnerInbox({connection:cfg,channel,downloadImage:guardedDownload,request:guardedRequest,onSubmitted:()=>submitted++});
   try{
    let input=await inbox();
    if(input.attentionRequired){await receipt({...input,inboundSubmitted:submitted});return input;}
    if(controller.signal.aborted||await stopRequested())break;
    stage='poll';let poll;
    try{poll=await channel.pollOwnerMessages({notBeforeMs:cfg.activatedAt});}
    catch(error){if(['network_error','timeout'].includes(error?.code))retryable=error;throw error;}
    if(!['idle','pending','inbox_full'].includes(poll.state)){await receipt({state:poll.state,accepted:0,inboundSubmitted:submitted});return {state:poll.state};}
    if(controller.signal.aborted||await stopRequested())break;
    stage='inbound';input=await inbox();
    if(input.attentionRequired){await receipt({...input,inboundSubmitted:submitted});return input;}
    stage='outbound';const deadline=now()+55000;
    const output=await forwardFullBatch({connection:cfg,channel,cursor,loadPlan,savePlan,request:guardedRequest,budgetRemaining:()=>deadline-now(),saveCursor:async value=>{await saveCursor(value);cursor=value;}});
    await receipt({...output,state:output.outboundBlocked?'outbound_blocked':output.state,inboundSubmitted:submitted,pendingCount:poll.pendingCount,consecutiveFailures:0});
    if(!output.outboundBlocked&&!['idle','forwarded','budget_exhausted'].includes(output.state))return output;
    failures=0;if(output.accepted)onAccepted(output);
    if(!controller.signal.aborted)await pause(output.hasMore?1000:3000,controller.signal);
   }catch(error){
    if(error!==retryable)throw error;
    failures++;const delay=Math.min(300000,15000*2**Math.min(5,failures-1));
    await receipt({state:'retry_wait',stage,error:error.code,accepted:0,inboundSubmitted:submitted,consecutiveFailures:failures,nextWaitMilliseconds:delay});
    if(!controller.signal.aborted)await pause(delay,controller.signal);
   }
  }
  await receipt({state:'stopped',accepted:0});return {state:'stopped'};
 }finally{signals.off('SIGINT',stop);signals.off('SIGTERM',stop);}
}
