import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};

// A recovery is an explicit new attempt for one confirmed rejection. It never
// changes the old native receipt and never applies to unknown delivery outcomes.
export function inspectRejectedPart({plan,account,sourceId,updatedAt,now=Date.now()}){
 if(!/^dots-[a-f0-9]{64}$/.test(sourceId)||!Number.isSafeInteger(updatedAt)||updatedAt<1)fail('INVALID_RECOVERY_TARGET');
 if(!plan||plan.format!=='dots-weixin-outbound-plan-v1'||plan.sourceId!==sourceId||plan.completed===true||!Array.isArray(plan.parts)||!plan.parts.length||plan.parts.length>20||plan.parts.some(p=>typeof p!=='string'||!p.length||p.length>4000)||!Number.isInteger(plan.nextPart)||plan.nextPart<0||plan.nextPart>=plan.parts.length||plan.contentHash!==hash(plan.parts.join(''))||plan.blocked?.state!=='rejected'||plan.blocked.reason!=='remote_rejected')fail('EXACT_REJECTED_PLAN_REQUIRED');
 const notificationId=sourceId+'-p'+(plan.nextPart+1),native=account?.notifications?.[notificationId];
 if(!account?.binding||!native||native.state!=='rejected'||native.reason!=='remote_rejected'||native.updatedAt!==updatedAt||native.diagnostics?.ret!==plan.blocked.diagnostics?.ret||!Number.isSafeInteger(native.diagnostics?.ret)||native.diagnostics.ret===0||native.textHash!==hash(plan.parts[plan.nextPart]))fail('EXACT_NATIVE_REJECTION_REQUIRED');
 if(Object.values(account.notifications).some(record=>record.state==='sending'))fail('NATIVE_SEND_IN_PROGRESS');
 // This ten-minute operator freshness policy is not a claim about protocol TTL.
 const contextAt=account.context?.receivedAt;
 if(!Number.isSafeInteger(contextAt)||contextAt<=native.updatedAt||contextAt>now||now-contextAt>600000)fail('FRESH_OWNER_MESSAGE_REQUIRED');
 let sequence;try{sequence=JSON.parse(Buffer.from(plan.sourceCursor,'base64url').toString('utf8'));}catch{fail('INVALID_SOURCE_CURSOR');}
 if(!Number.isSafeInteger(sequence)||sequence<1||Buffer.from(JSON.stringify(sequence)).toString('base64url')!==plan.sourceCursor)fail('INVALID_SOURCE_CURSOR');
 const retryId=notificationId+'-recover1';
 if(account.notifications[retryId])fail('RECOVERY_ALREADY_ATTEMPTED');
 return {sourceId,sourceCursor:plan.sourceCursor,sequence,part:plan.nextPart,notificationId,retryId,originalUpdatedAt:native.updatedAt,ret:native.diagnostics.ret,contextUpdatedAt:contextAt,textHash:native.textHash};
}

export async function retryRejectedPart({plan,account,sourceId,updatedAt,now,apply=false,allowRetryRejected=false,operations}){
 const target=inspectRejectedPart({plan,account,sourceId,updatedAt,now});
 if(!apply)return {status:'ready-for-one-explicit-retry',...target,networkSendRequested:false};
 if(!allowRetryRejected)fail('EXPLICIT_RETRY_ACKNOWLEDGEMENT_REQUIRED');
 const original=JSON.stringify(plan),receipt={format:'dots-weixin-recovery-v1',...target,sendReserved:false,committed:false};
 // Backups and a durable transaction must exist before any external side effect.
 await operations.reserve(receipt);
 await operations.backup(plan,account.notifications[target.notificationId],receipt);
 await operations.verifyUnchanged(original,target);
 receipt.sendReserved=true;await operations.saveTransaction(receipt);
 const result=await operations.send({notificationId:target.retryId,text:plan.parts[target.part]});
 receipt.retryState=result.state;
 if(result.state!=='accepted'){
  await operations.saveTransaction(receipt);
  return {status:'recovery-not-accepted-original-pause-retained',retryState:result.state,networkSendRequested:true,originalReceiptPreserved:true,cursorChanged:false};
 }
 // The normal worker owns cursor advancement after all parts are accepted.
 await operations.verifyUnchanged(original,target);
 const next=JSON.parse(original);next.nextPart=target.part+1;delete next.blocked;
 await operations.savePlan(next,original);
 receipt.committed=true;await operations.saveTransaction(receipt);
 return {status:'one-part-accepted-forwarder-unblocked',retryState:'accepted',networkSendRequested:true,originalReceiptPreserved:true,cursorChanged:false,taskRestarted:false};
}
