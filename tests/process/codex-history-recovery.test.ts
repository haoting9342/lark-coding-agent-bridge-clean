import { mkdir, mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent } from '../../src/agent/types';
const dirs:string[]=[];
const id='01a06b52-faae-70e3-846c-cb51eb9d412a';
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(options:{repeat?:boolean;tool?:boolean;mcp?:boolean;otherError?:boolean;shared?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'history-recovery-'));dirs.push(root);
 const home=join(root,options.shared?'shared':'provider-codex-home');await mkdir(join(home,'sessions'),{recursive:true});
 const file=join(home,'sessions',`rollout-${id}.jsonl`);const other=join(home,'sessions','unrelated.jsonl');await writeFile(other,'unreadable history must stay untouched');
 await writeFile(file,[{type:'session_meta',payload:{id}},{type:'response_item',payload:{id:'item_old',type:'reasoning',summary:[]}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const binary=join(root,'fake.mjs');const records=join(root,'runs.jsonl');
 const failure=options.otherError?'rate limit':"Invalid 'input[39].id': 'item_old'. Expected an ID that begins with 'rs'.";
 await writeFile(binary,`#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';
let prompt='';for await(const x of process.stdin)prompt+=x;
appendFileSync(${JSON.stringify(records)},JSON.stringify({prompt,args:process.argv.slice(2)})+'\\n');
const rows=readFileSync(${JSON.stringify(file)},'utf8').trim().split('\\n').map(x=>JSON.parse(x));
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(id)}}));
if(rows[1].payload.id || ${!!options.repeat}){
 if(${!!options.mcp}) console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',id:'mcp'}}));
 if(${!!options.tool}) console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',id:'tool',command:'test'}}));
 console.log(JSON.stringify({type:'turn.failed',error:{message:${JSON.stringify(failure)}}}));
 setTimeout(()=>{appendFileSync(${JSON.stringify(file)},JSON.stringify({type:'event_msg',payload:{type:'tail'}})+'\\n');process.exit(1)},150);
}else{console.log(JSON.stringify({type:'agent_message',message:'original command completed'}));console.log(JSON.stringify({type:'turn.completed'}));}
`);await chmod(binary,0o755);
 const adapter=new CodexAdapter({binary,profileStateDir:root,codexHome:home});
 const run=adapter.run({cwd:root,runId:'r',threadId:id,prompt:'original command',model:'test-model',images:['/tmp/image.png']});
 return {run,file,other,records,adapter};
}
async function collect(events:AsyncIterable<AgentEvent>){const out:AgentEvent[]=[];for await(const e of events)out.push(e);return out;}
it('repairs only the failed thread after process exit and transparently replays the original options',async()=>{
 const h=await fixture();const events=await collect(h.run.events);expect(events.some(e=>e.type==='error')).toBe(false);
 expect(events.some(e=>e.type==='text'&&e.delta.includes('修复'))).toBe(true);expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'normal'});
 const attempts=(await readFile(h.records,'utf8')).trim().split('\n').map(x=>JSON.parse(x));expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
 expect(await readFile(h.other,'utf8')).toBe('unreadable history must stay untouched');expect(await readFile(h.file,'utf8')).toContain('tail');
});
it('retries at most once and reports a concise failure if the retry still fails',async()=>{
 const h=await fixture({repeat:true});const events=await collect(h.run.events);expect(events.at(-1)).toMatchObject({type:'error'});expect((await readFile(h.records,'utf8')).trim().split('\n')).toHaveLength(2);
 await h.run.waitForExit(1000);
});
for(const options of [{otherError:true},{tool:true},{mcp:true},{shared:true}])it(`does not repair or retry unsafe/unrelated failures ${JSON.stringify(options)}`,async()=>{
 const h=await fixture(options);const events=await collect(h.run.events);expect(events.at(-1)).toMatchObject({type:'error'});expect((await readFile(h.records,'utf8')).trim().split('\n')).toHaveLength(1);await h.run.waitForExit(1000);expect(await readFile(h.file,'utf8')).toContain('item_old');
});
it('stop during the recovery notice prevents the retry',async()=>{
 const h=await fixture();for await(const e of h.run.events){if(e.type==='text'&&e.delta.includes('修复')) await h.run.stop();}
 expect((await readFile(h.records,'utf8')).trim().split('\n')).toHaveLength(1);
});
