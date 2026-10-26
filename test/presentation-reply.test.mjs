import test from 'node:test';
import assert from 'node:assert/strict';
import {createPresentation} from '../lib/presentation.mjs';
test('reply-specific links preserve original text and attachment after another reply without changing legacy links',()=>{
 const now=100000,oldFile={id:'media_old',fileName:'old.txt',mimeType:'text/plain',size:3,expiresAt:now+100000},newFile={...oldFile,id:'media_new',fileName:'new.txt'};
 const task={id:'QG-123456abcdef',state:'replied',reply:'new reply body',replyFiles:[newFile]};
 const store={view(){return task;},findReply(_id,replyId){return replyId==='old-reply'?{text:'original reply body',files:[oldFile],summary:'old'}:null;}};
 const media={get(){},resolveAsset(id){return {path:id,meta:{id}};}};
 const presentation=createPresentation({base:'https://example.test/dots',secret:'secret',now:()=>now,store,media});
 const old=presentation.decorate({...task,reply:'original reply body',replyFiles:[oldFile]},{replyId:'old-reply'});
 assert.match(presentation.page(new URL(old.resultUrl),task.id),/original reply body/);
 assert.doesNotMatch(presentation.page(new URL(old.resultUrl),task.id),/new reply body|new\.txt/);
 assert.equal(presentation.asset(new URL(old.attachments[0].url),oldFile.id).path,oldFile.id);
 const changed=new URL(old.resultUrl);changed.searchParams.set('reply','new-reply');assert.equal(presentation.page(changed,task.id),null);
 const removed=new URL(old.resultUrl);removed.searchParams.delete('reply');assert.equal(presentation.page(removed,task.id),null);
 const legacy=presentation.decorate(task);assert.equal(new URL(legacy.resultUrl).searchParams.has('reply'),false);
 assert.match(presentation.page(new URL(legacy.resultUrl),task.id),/new reply body/);
 assert.equal(presentation.asset(new URL(old.attachments[0].url),newFile.id),null);
});
