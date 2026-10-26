import { createHash } from 'node:crypto';

const error = () => { throw Object.assign(new Error('通知游标不正确'), {status:400}); };
const idFor = parts => 'dots-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const encode = item => Buffer.from(JSON.stringify(item.sequence)).toString('base64url');
function decode(cursor) {
  if(!cursor)return null;
  if(typeof cursor!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(cursor))return error();
  let value;try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{return error();}
  if(!Number.isSafeInteger(value)||value<0)return error();
  const item={sequence:value};if(encode(item)!==cursor)return error();return item;
}
// Called before a store transaction. Old records receive stable initial numbers;
// every subsequent commit allocates a higher number even if the clock moves back.
export function prepareNotificationSequences(state){
  const entries=[];
  for(const task of state.tasks)for(const reply of task.replies||[])entries.push({entry:reply,key:JSON.stringify(['reply',task.id,reply.replyId])});
  for(const notice of state.notifications)entries.push({entry:notice,key:JSON.stringify(['notice',notice.owner,notice.notificationId])});
  if(state.notificationSequence===undefined){
    entries.sort((a,b)=>a.entry.createdAt-b.entry.createdAt||(a.key<b.key?-1:a.key>b.key?1:0));
    entries.forEach(({entry},index)=>{entry.notificationSequence=index+1;});state.notificationSequence=entries.length;
  }
  const seen=new Set();
  if(!Number.isSafeInteger(state.notificationSequence)||state.notificationSequence<0)throw Object.assign(new Error('通知序号状态不正确'),{status:500});
  for(const {entry}of entries){const seq=entry.notificationSequence;if(seq===undefined)continue;if(!Number.isSafeInteger(seq)||seq<1||seq>state.notificationSequence||seen.has(seq))throw Object.assign(new Error('通知序号状态不正确'),{status:500});seen.add(seq);}
  // An older app used during an approved code rollback can append legacy records.
  // Preserve every existing sequence and append those records after the counter.
  entries.filter(x=>x.entry.notificationSequence===undefined).sort((a,b)=>a.entry.createdAt-b.entry.createdAt||(a.key<b.key?-1:a.key>b.key?1:0)).forEach(({entry})=>{entry.notificationSequence=allocateNotificationSequence(state);});
}
export function allocateNotificationSequence(state){
  if(state.notificationSequence>=Number.MAX_SAFE_INTEGER)throw Object.assign(new Error('通知序号容量已满'),{status:429});
  return ++state.notificationSequence;
}
function message(text) {
  const full='Dots 回复了：\n'+text;
  const suffix='\n\n完整图文请在千问查询 Dots 回复。';
  return full.length<=4000?full:full.slice(0,4000-suffix.length-1)+'…'+suffix;
}
// Read-only view of committed replies. No separate enqueue can be lost on crash.
// The dedicated relay credential never grants photo reads or task submission.
export function notificationFeed(state,{after='',since=0,owner='owner',limit=20}={}) {
  if(!Number.isSafeInteger(since)||since<0||!Number.isInteger(limit)||limit<1||limit>20)return error();
  prepareNotificationSequences(state);
  const cursor=decode(after),items=[];
  for(const task of state.tasks)if(task.owner===owner)for(const reply of task.replies||[]){
    items.push({id:idFor(['reply',task.id,reply.replyId]),sequence:reply.notificationSequence,createdAt:reply.createdAt,text:message(reply.text),kind:'reply'});
  }
  for(const item of state.notifications)if(item.owner===owner){
    items.push({id:idFor(['notice',item.notificationId]),sequence:item.notificationSequence,createdAt:item.createdAt,text:message(item.text),kind:item.kind});
  }
  const eligible=items.filter(x=>cursor?x.sequence>cursor.sequence:x.createdAt>=since).sort((a,b)=>a.sequence-b.sequence);
  const page=eligible.slice(0,limit);
  return {format:'dots-weixin-outbox-v1',items:page.map(x=>({...x,cursor:encode(x)})),hasMore:eligible.length>limit};
}

// New capability: full source text and attachment references. The legacy
// read-only credential/format stays unchanged until its worker is replaced.
export function fullNotificationFeed(state,{after='',owner='owner',limit=5}={}){
  if(!Number.isInteger(limit)||limit<1||limit>5)return error();
  prepareNotificationSequences(state);
  const cursor=decode(after);if(!cursor)return error();
  const entries=[];
  for(const task of state.tasks)if(task.owner===owner)for(const reply of task.replies||[]){
    entries.push({id:idFor(['reply',task.id,reply.replyId]),sequence:reply.notificationSequence,createdAt:reply.createdAt,text:'Dots 回复了：\n'+reply.text,kind:'reply',taskId:task.id,replyId:reply.replyId,hasFiles:!!reply.files?.length});
  }
  for(const item of state.notifications)if(item.owner===owner){
    entries.push({id:idFor(['notice',item.notificationId]),sequence:item.notificationSequence,createdAt:item.createdAt,text:'Dots 回复了：\n'+item.text,kind:item.kind,taskId:null,replyId:null,hasFiles:false});
  }
  const eligible=entries.filter(item=>item.sequence>cursor.sequence).sort((a,b)=>a.sequence-b.sequence);
  return {format:'dots-weixin-outbox-v2',items:eligible.slice(0,limit).map(item=>({...item,cursor:encode(item)})),hasMore:eligible.length>limit};
}
