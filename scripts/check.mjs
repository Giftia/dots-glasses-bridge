import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','.dot-events'].includes(entry.name))continue;const target=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Symlink refused');if(entry.isDirectory())walk(target);else if(entry.name.endsWith('.mjs'))files.push(target);}}
walk(root);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
