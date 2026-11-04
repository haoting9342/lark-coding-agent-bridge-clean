import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { repairCodexHistory } from '../../src/runtime/codex-history-repair';
const dirs:string[]=[];
const id='01a06b52-faae-70e3-846c-cb51eb9d412a';
const name=`rollout-${id}.jsonl`;
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(){const h=await mkdtemp(join(tmpdir(),'repair-history-'));dirs.push(h);await mkdir(join(h,'sessions'));return h;}
it('removes only generic response IDs, preserves bytes/offsets, event IDs and call relationships',async()=>{
 const h=await fixture();const file=join(h,'sessions',name);
 const rows=[{type:'session_meta',payload:{id,originator:'codex_cli_rs'}},{type:'event_msg',payload:{id:'item_keep',type:'item_completed'}},{type:'response_item',payload:{id:'item_reason',type:'reasoning',summary:[{text:'中文'}]}},{type:'response_item',payload:{type:'function_call',call_id:'call_keep',arguments:'{"id":"item_inside"}',id:'item_call'}},{type:'response_item',payload:{type:'message',id:'msg_valid',content:[]}}];
 const before=rows.map(r=>JSON.stringify(r)).join('\r\n')+'\r\n';await writeFile(file,before);
 const result=await repairCodexHistory(h,id);expect(result.removedIds).toBe(2);expect(result.files).toBe(1);
 const after=await readFile(file);expect(after.length).toBe(Buffer.byteLength(before));
 const output=after.toString().trim().split('\r\n').map(l=>JSON.parse(l));
 const expected=JSON.parse(JSON.stringify(rows));delete expected[2].payload.id;delete expected[3].payload.id;expect(output).toEqual(expected);
 expect(after.toString().split('\r\n').map(l=>Buffer.byteLength(l))).toEqual(before.split('\r\n').map(l=>Buffer.byteLength(l)));
 expect(await readFile(join(result.backupDir!,'sessions',name),'utf8')).toBe(before);
 expect((await repairCodexHistory(h,id)).removedIds).toBe(0);
});
it('does not follow a link outside the dedicated home',async()=>{
 const h=await fixture();const outside=join(h,'outside');await writeFile(outside,JSON.stringify({type:'response_item',payload:{id:'item_unsafe',type:'reasoning'}}));await symlink(outside,join(h,'sessions','link.jsonl'));
 await expect(repairCodexHistory(h,id)).rejects.toThrow();expect(await readFile(outside,'utf8')).toContain('item_unsafe');
});
it('rejects malformed JSON before replacing that rollout',async()=>{
 const h=await fixture();const file=join(h,'sessions',name);const source=JSON.stringify({type:'session_meta',payload:{id}})+'\n'+JSON.stringify({type:'response_item',payload:{id:'item_unsafe',type:'reasoning'}})+'\n{broken';await writeFile(file,source);
 await expect(repairCodexHistory(h,id)).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(source);
});

it('restores base64 agent messages without touching real ciphertext, IDs, compaction or byte offsets', async () => {
 const h=await fixture();const file=join(h,'sessions',name);
 const message='子任务完成。\n保留 "结果" 和原 thread。';
 const encoded='c2a-msg-v1:'+Buffer.from(message).toString('base64');
 const agentMessage={type:'agent_message',id:'amsg_keep',author:'/root/worker',recipient:'/root',content:[{type:'input_text',text:'Payload:\n'},{type:'encrypted_content',encrypted_content:encoded}],internal_chat_message_metadata_passthrough:{content_item_metadata:[{provenance:{type:'tool'}},{provenance:{type:'tool'}}]}};
 const rows=[{type:'session_meta',payload:{id}},{type:'response_item',payload:agentMessage},{type:'response_item',payload:{type:'reasoning',id:'item_keep',encrypted_content:'real-ciphertext'}},{type:'response_item',payload:{...agentMessage,content:[{type:'encrypted_content',encrypted_content:'opaque-ciphertext'}]}},{type:'compacted',payload:{replacement_history:[agentMessage,{type:'compaction',encrypted_content:'opaque-summary'}]}}];
 const before=rows.map(r=>JSON.stringify(r)).join('\r\n')+'\r\n';await writeFile(file,before);
 const result=await repairCodexHistory(h,id,{kind:'encoded-agent-message'});
 expect(result).toMatchObject({files:1,removedIds:0,restoredMessages:2});
 const expected=structuredClone(rows);
 (expected[1]!.payload as typeof agentMessage).content[1]={type:'input_text',text:message};
 ((expected[4]!.payload as {replacement_history:typeof agentMessage[]}).replacement_history[0]!).content[1]={type:'input_text',text:message};
 const after=await readFile(file,'utf8');expect(after.trim().split('\r\n').map(l=>JSON.parse(l))).toEqual(expected);
 expect(after.split('\r\n').map(l=>Buffer.byteLength(l))).toEqual(before.split('\r\n').map(l=>Buffer.byteLength(l)));
 expect(await readFile(join(result.backupDir!,'sessions',name),'utf8')).toBe(before);
 expect(await repairCodexHistory(h,id,{kind:'encoded-agent-message'})).toMatchObject({files:0,restoredMessages:0});
});

it.each(['c2a-msg-v1:%%%','c2a-msg-v1:/w==','c2a-msg-v1:YR=='])(
 'rejects invalid encoded agent content without rewriting the rollout: %s',async(encoded)=>{
 const h=await fixture();const file=join(h,'sessions',name);
 const before=[{type:'session_meta',payload:{id}},{type:'response_item',payload:{type:'agent_message',content:[{type:'encrypted_content',encrypted_content:encoded}]}}].map(r=>JSON.stringify(r)).join('\n')+'\n';
 await writeFile(file,before);
 await expect(repairCodexHistory(h,id,{kind:'encoded-agent-message'})).rejects.toThrow();
 expect(await readFile(file,'utf8')).toBe(before);
});
