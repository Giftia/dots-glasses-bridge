import test from 'node:test';
import assert from 'node:assert/strict';
import {scanText} from '../scripts/audit-release.mjs';
test('release scanner flags credential material without echoing it',()=>{
 const samples=[['-----BEGIN '+'PRIVATE KEY-----','private-key'],['ghp_'+'A'.repeat(36),'github-token'],['https://'+'person:secret@service.example/path','credential-url'],['AKIA'+'A'.repeat(16),'aws-access-key']];
 for(const [text,rule] of samples){const findings=scanText(text);assert.ok(findings.includes(rule));assert.ok(!JSON.stringify(findings).includes(text));}
 assert.deepEqual(scanText('https://dots.example.com/dots and placeholders only'),[]);
});
