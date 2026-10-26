import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const fail=()=>{throw Object.assign(new Error('READ_ONLY_STATUS_UNAVAILABLE'),{code:'READ_ONLY_STATUS_UNAVAILABLE'});};
function read(directory,name,max){
 if(!path.isAbsolute(directory))fail();
 for(let current=path.resolve(directory);;current=path.dirname(current)){const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())fail();if(path.dirname(current)===current)break;}
 const file=path.join(directory,name);if(!fs.existsSync(file))return null;
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)fail();
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
const states=new Set(['starting','stopped','idle','forwarded','outbound_blocked','retry_wait','waiting_for_owner_context','budget_exhausted']);
function block(value){
 if(!value||!['unknown','rejected'].includes(value.state))return null;
 const diagnostics={};for(const key of ['ret','errcode','httpStatus'])if(Number.isSafeInteger(value.diagnostics?.[key]))diagnostics[key]=value.diagnostics[key];
 return {state:value.state,reason:value.reason==='remote_rejected'?'remote_rejected':'other',diagnostics};
}
export function status(relay,channel){
 const receipt=read(relay,'receipt.json',8192),plan=read(relay,'outbound-plan.json',512*1024),account=read(channel,'weixin-channel.json',4*1024*1024),counts={};
 for(const record of Object.values(account?.notifications||{}))if(['sending','accepted','unknown','rejected'].includes(record.state))counts[record.state]=(counts[record.state]||0)+1;
 return {readOnly:true,snapshotAtomicAcrossFiles:false,checkedAt:typeof receipt?.checkedAt==='string'?receipt.checkedAt:null,state:states.has(receipt?.state)?receipt.state:'other',outboundBlocked:!!plan?.blocked,block:block(plan?.blocked),ownerBound:!!account?.binding,contextReady:!!account?.context,contextUpdatedAt:Number.isSafeInteger(account?.context?.receivedAt)?account.context.receivedAt:null,nativeCounts:counts,phoneReceiptVerified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{if(process.argv.length!==4)fail();console.log(JSON.stringify(status(process.argv[2],process.argv[3]),null,2));}catch{console.log(JSON.stringify({readOnly:true,error:'READ_ONLY_STATUS_UNAVAILABLE'}));process.exitCode=1;}
}
