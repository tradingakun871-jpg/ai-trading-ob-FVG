import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const startPath=path.join(__dirname,'start.js');
let s=fs.readFileSync(startPath,'utf8');

const bad="setTimeout(()=>{recoverMt5ExecutionQueue().catch(e=>console.error('MT5 recovery startup failed:',e.message))},2500);";
const writeNeedle="fs.writeFileSync(serverPath,source,'utf8');";
const inject=`source += "\\nsetTimeout(()=>{recoverMt5ExecutionQueue().catch(e=>console.error('MT5 recovery startup failed:',e.message))},2500);\\n";\n`;

if(s.includes(bad)) s=s.replace(bad,'');
if(!s.includes('source += "\\nsetTimeout(()=>{recoverMt5ExecutionQueue()') && s.includes(writeNeedle)){
  s=s.replace(writeNeedle,inject+writeNeedle);
}
fs.writeFileSync(startPath,s,'utf8');
console.log('Startup recovery hotfix prepared');
await import('./start.js');
