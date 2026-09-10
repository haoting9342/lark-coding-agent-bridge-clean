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
