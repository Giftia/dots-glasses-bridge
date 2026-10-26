import https from 'node:https';

const fail = code => {throw Object.assign(new Error(code),{code});};
export function validateConnection(value){
  if(!value||value.format!=='dots-weixin-relay-connection-v1'||typeof value.baseUrl!=='string'||!Number.isSafeInteger(value.since)||value.since<0||!Number.isFinite(new Date(value.since).getTime())||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(value.token)||typeof value.after!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(value.after))fail('INVALID_CONNECTION');
  let sequence;try{sequence=JSON.parse(Buffer.from(value.after,'base64url').toString('utf8'));}catch{fail('INVALID_CONNECTION');}
  if(!Number.isSafeInteger(sequence)||sequence<0||Buffer.from(JSON.stringify(sequence)).toString('base64url')!==value.after)fail('INVALID_CONNECTION');
  let url;try{url=new URL(value.baseUrl);}catch{fail('INVALID_CONNECTION');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/dots'||url.search||url.hash)fail('INVALID_CONNECTION');
  return {format:value.format,baseUrl:url.origin+'/dots',since:value.since,token:value.token,after:value.after};
}
export function fetchFeed(connection,after=''){
  const config=validateConnection(connection),url=new URL(config.baseUrl+'/weixin/outbox');
  url.searchParams.set('since',String(config.since));if(after)url.searchParams.set('after',after);
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{agent:false,headers:{Authorization:'Bearer '+config.token}},res=>{
      let size=0;const chunks=[];
      if(res.statusCode!==200){res.resume();reject(Object.assign(new Error('FEED_HTTP_ERROR'),{code:'FEED_HTTP_ERROR'}));return;}
      res.on('data',chunk=>{size+=chunk.length;if(size>512*1024)req.destroy(Object.assign(new Error('FEED_TOO_LARGE'),{code:'FEED_TOO_LARGE'}));else chunks.push(chunk);});
      res.on('error',()=>reject(Object.assign(new Error('FEED_NETWORK_ERROR'),{code:'FEED_NETWORK_ERROR'})));
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Object.assign(new Error('INVALID_FEED'),{code:'INVALID_FEED'}));}});
    });
    const timer=setTimeout(()=>req.destroy(Object.assign(new Error('FEED_TIMEOUT'),{code:'FEED_TIMEOUT'})),10000);
    req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(Object.assign(new Error('FEED_NETWORK_ERROR'),{code:'FEED_NETWORK_ERROR'})));
  });
}
export function validateFeed(feed){
  if(!feed||feed.format!=='dots-weixin-outbox-v1'||!Array.isArray(feed.items)||feed.items.length>20||typeof feed.hasMore!=='boolean')fail('INVALID_FEED');
  const ids=new Set();for(const item of feed.items){
    if(!item||!/^dots-[a-f0-9]{64}$/.test(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>4000||typeof item.cursor!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(item.cursor)||!Number.isSafeInteger(item.createdAt)||item.createdAt<0||ids.has(item.id))fail('INVALID_FEED');
    ids.add(item.id);
  }
  return feed;
}
// Persisting each accepted cursor after the channel's durable send receipt
// makes a crash replay harmless. Unknown/rejected sends never auto-resend.
export async function forwardBatch({connection,channel,cursor='',fetch=fetchFeed,saveCursor,budgetRemaining=()=>Infinity}){
  validateConnection(connection);const feed=validateFeed(await fetch(connection,cursor||connection.after));
  let accepted=0;
  if(!feed.items.length)return {state:'idle',accepted,hasMore:false};
  const status=await channel.status();if(!status.ownerBound||!status.contextReady)return {state:'waiting_for_owner_context',accepted};
  for(const item of feed.items){
    if(budgetRemaining()<16000)return {state:'budget_exhausted',accepted,hasMore:true};
    const receipt=await channel.sendNotification({notificationId:item.id,text:item.text});
    if(receipt.state!=='accepted')return {state:receipt.state,accepted,attentionRequired:true};
    await saveCursor(item.cursor);accepted++;
  }
  return {state:'forwarded',accepted,hasMore:feed.hasMore};
}
