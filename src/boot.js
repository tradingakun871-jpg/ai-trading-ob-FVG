import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const startPath=path.join(__dirname,'start.js');
let s=fs.readFileSync(startPath,'utf8');
const bad="setTimeout(()=>{recoverMt5ExecutionQueue().catch(e=>console.error('MT5 recovery startup failed:',e.message))},2500);";
const tail="fs.writeFileSync(serverPath,source,'utf8');\nawait import('./server.js');\n"+bad;
const fixed="source += \\\"\\nsetTimeout(()=>{recoverMt5ExecutionQueue().catch(e=>console.error('MT5 recovery startup failed:',e.message))},2500);\\n\\\";\nfs.writeFileSync(serverPath,source,'utf8');\nawait import('./server.js');";
if(s.includes(tail)){
  s=s.replace(tail,fixed);
  fs.writeFileSync(startPath,s,'utf8');
  console.log('Startup hotfix applied: recovery now runs inside generated server scope');
}else if(s.includes(bad)){
  s=s.replace(bad,'');
  fs.writeFileSync(startPath,s,'utf8');
  console.log('Startup safety hotfix applied: removed invalid outer recovery call');
}else{
  console.log('Startup hotfix not needed');
}
await import('./start.js');
