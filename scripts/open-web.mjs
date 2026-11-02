import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
let fileEnv={};
try { fileEnv=parseEnv(await readFile(new URL('../../../.env',import.meta.url),'utf8')); }
catch(error) { if(error.code!=='ENOENT')throw error; }
const env={...fileEnv,...process.env};
const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/writing-scaffold.mjs',import.meta.url)),'--transport','http','--port','0'],{env,stdio:['ignore','inherit','pipe']});
let opened=false,log='';
child.stderr.on('data',chunk=>{
  process.stderr.write(chunk);log+=String(chunk);
  const match=/listening on (http:\/\/[^\s]+)\/mcp/.exec(log);
  if(match&&!opened){opened=true;const url=match[1]+'/app';console.log(`Detemplatize: ${url}\nKeep this terminal open while using the page.`);
    const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
    if(!process.argv.includes('--no-open')){const browser=spawn(command,[url],{stdio:'ignore'});browser.on('error',()=>console.log(`Open ${url} in your browser.`));}
  }
});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
