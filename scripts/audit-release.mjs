import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const rules=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
 ['credential-url',/https?:\/\/[^\s/@<>"']+:[^\s/@<>"']+@/g],
 ['aws-access-key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];
export function scanText(text){return rules.filter(([,pattern])=>{pattern.lastIndex=0;return pattern.test(text);}).map(([name])=>name);}
const forbiddenFiles=new Set(['owner-code.txt','weixin-channel.json','LoginQR.png','connection.json','inbound-connection.json','cursor.json','outbound-plan.json','receipt.json','config.json']);
export function audit(root){
 const findings=[];let count=0;
 const allowFile=path.join(root,'.release-audit-allowlist.json');
 const allowed=fs.existsSync(allowFile)?JSON.parse(fs.readFileSync(allowFile,'utf8')):[];
 let reviewedFixtures=0;
 function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(['.git','node_modules'].includes(entry.name))continue;
  const file=path.join(directory,entry.name),relative=path.relative(root,file).split(path.sep).join('/');
  if(entry.isSymbolicLink()){findings.push({file:relative,rule:'unreviewed-symlink'});continue;}
  if(entry.isDirectory()){
   if(['.dot-events','private','runtime'].includes(entry.name)||entry.name.endsWith('-private'))findings.push({file:relative,rule:'private-runtime-directory'});
   else visit(file);
  }else{
   count++;
   if(forbiddenFiles.has(entry.name)||/^\.env(?:\.|$)/.test(entry.name)&&entry.name!=='.env.example'||/\.(?:ppk|pem|pfx|key|zip|log)$/i.test(entry.name))findings.push({file:relative,rule:'private-or-unreviewed-file'});
   const size=fs.statSync(file).size;
   if(size>2*1024*1024){findings.push({file:relative,rule:'unreviewed-large-file'});continue;}
   const bytes=fs.readFileSync(file);
   if(bytes.includes(0)){findings.push({file:relative,rule:'unreviewed-binary'});continue;}
   for(const rule of scanText(bytes.toString('utf8'))){
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(rule==='credential-url'&&relative.startsWith('test/')&&allowed.some(entry=>entry.file===relative&&entry.rule===rule&&entry.sha256===digest)){reviewedFixtures++;continue;}
    findings.push({file:relative,rule});
   }
  }
 }}
 visit(root);return {filesScanned:count,reviewedFixtures,findings};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),report=audit(root);
 console.log(JSON.stringify(report,null,2));if(report.findings.length)process.exitCode=1;
}
