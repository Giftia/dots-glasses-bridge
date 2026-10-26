import { createHmac, timingSafeEqual } from 'node:crypto';

const LIFE = 15 * 60 * 1000;
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const same = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&x.length>0&&timingSafeEqual(x,y); };
function richText(value){
  const text=String(value||''),pattern=/https:\/\/[^\s<>"'，。；！？）】]+/g;let result='',last=0;
  for(const match of text.matchAll(pattern)){
    result+=escape(text.slice(last,match.index));let url;
    try{url=new URL(match[0]);if(url.username||url.password)url=null;}catch{}
    result+=url?'<a rel="noreferrer noopener" href="'+escape(url.href)+'">'+escape(match[0])+'</a>':escape(match[0]);last=match.index+match[0].length;
  }
  return result+escape(text.slice(last));
}
export function createPresentation({base,secret,now=Date.now,store,media}) {
  const signature = (type,id,taskId,expires,replyId='') => createHmac('sha256',secret).update(JSON.stringify(['owner',type,id,taskId,expires,...(replyId?[replyId]:[])])).digest('base64url');
  const link = (type,id,taskId,expires,replyId='') => base+'/'+type+'/'+encodeURIComponent(id)+'?task='+encodeURIComponent(taskId)+'&expires='+expires+(replyId?'&reply='+encodeURIComponent(replyId):'')+'&sig='+signature(type,id,taskId,expires,replyId);
  function check(url,type,id) {
    const replyId=url.searchParams.get('reply')||'';
    if ([...url.searchParams.keys()].sort().join(',')!==(replyId?'expires,reply,sig,task':'expires,sig,task')||replyId.length>128||replyId.includes('\0')) return null;
    const expires=Number(url.searchParams.get('expires')), taskId=url.searchParams.get('task'),sig=url.searchParams.get('sig')||'';
    if (!Number.isSafeInteger(expires)||expires<=now()||expires>now()+LIFE||!/^[A-Za-z0-9_-]{43}$/.test(sig)||!same(sig,signature(type,id,taskId,expires,replyId))) return null;
    try {
      let task=store.view(taskId,'owner');if(task.state!=='replied')return null;
      if(replyId){const previous=store.findReply(taskId,replyId,'owner');if(!previous)return null;task={...task,reply:previous.text,replySummary:previous.summary,replyFiles:previous.files};}
      return {task,expires,replyId};
    } catch {return null;}
  }
  function decorate(task,{replyId=''}={}) {
    if(task.state!=='replied'||!task.reply)return task;
    const files=task.replyFiles||[];
    if(!files.length)return task;
    const expires=Math.min(now()+LIFE,...files.map(file=>file.expiresAt));
    if(expires<=now())return {...task,attachmentsExpired:true};
    return {...task,resultUrl:link('results',task.id,task.id,expires,replyId),resultExpiresAt:expires,
      attachments:files.map(file=>({fileName:file.fileName,mimeType:file.mimeType,size:file.size,url:link('assets',file.id,task.id,expires,replyId)}))};
  }
  function page(url,id) {
    const valid=check(url,'results',id);if(!valid||valid.task.id!==id)return null;
    const {task,expires,replyId}=valid;
    const assets=(task.replyFiles||[]).map(file=>{try{media.get(file.id,'owner');const href=escape(link('assets',file.id,task.id,expires,replyId));
      return file.mimeType.startsWith('image/')?'<figure><img alt="'+escape(file.fileName||'Dot返回的图片')+'" src="'+href+'"><figcaption>'+escape(file.fileName)+'</figcaption></figure>':'<p><a href="'+href+'">下载 '+escape(file.fileName||'附件')+'</a></p>';
    }catch{return '<p>此附件已过期，请重新查询。</p>';}}).join('');
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 的回复</title><style>body{font:17px/1.7 system-ui,sans-serif;background:#f2f6f5;color:#17322e;margin:0;padding:22px}main{max-width:760px;margin:auto}h1{font-size:25px}.reply{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto;border-radius:12px}figure{margin:24px 0}figcaption,small{color:#56716b}a{color:#087f72}</style><main><h1>Codex 的回复</h1><div class="reply">'+richText(task.reply)+'</div>'+assets+'<p><small>链接有效期为 15 分钟以内。过期后可在千问重新查询回复。</small></p></main></html>';
  }
  function asset(url,id) {
    const valid=check(url,'assets',id);if(!valid||!(valid.task.replyFiles||[]).some(file=>file.id===id))return null;
    try{return media.resolveAsset(id,'owner');}catch{return null;}
  }
  return {decorate,page,asset};
}
