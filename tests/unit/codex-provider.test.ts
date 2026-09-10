import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getProviderStatus, switchProvider } from '../../src/runtime/codex-provider';
const dirs: string[]=[];
async function fixture(){
 const home=await mkdtemp(join(tmpdir(),'bridge-provider-'));dirs.push(home);
 await writeFile(join(home,'config.toml'),'model_provider = "OpenAI"\nmodel = "gpt-6-astra"\n[model_providers.OpenAI]\nname = "OpenAI"\nbase_url = "https://token.brioi.com"\nwire_api = "responses"\nrequires_openai_auth = true\n[mcp_servers.keep]\ncommand = "unchanged"\n');
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fake-api'}));
 await mkdir(join(home,'bridge-providers'));
 await writeFile(join(home,'bridge-providers','chatgpt.auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-access',refresh_token:'fake-refresh'}}));
 return home;
}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
it('switches both ways without changing model, MCP or source history',async()=>{
 const home=await fixture();await mkdir(join(home,'sessions'));await writeFile(join(home,'sessions','keep.jsonl'),'{"type":"event_msg","payload":{"text":"do not touch"}}');
 expect((await getProviderStatus(home)).mode).toBe('api');
 expect((await switchProvider(home,'chatgpt')).mode).toBe('chatgpt');
 let cfg=await readFile(join(home,'config.toml'),'utf8');expect(cfg).toContain('https://chatgpt.com/backend-api/codex');expect(cfg).toContain('model = "gpt-6-astra"');expect(cfg).toContain('command = "unchanged"');
 expect(JSON.parse(await readFile(join(home,'auth.json'),'utf8')).OPENAI_API_KEY).toBeUndefined();
 expect((await switchProvider(home,'api')).mode).toBe('api');expect(JSON.parse(await readFile(join(home,'auth.json'),'utf8')).OPENAI_API_KEY).toBe('fake-api');
 expect(await readFile(join(home,'sessions','keep.jsonl'),'utf8')).toBe('{"type":"event_msg","payload":{"text":"do not touch"}}');
 expect(JSON.stringify(await getProviderStatus(home))).not.toMatch(/fake-api|fake-access|fake-refresh/);
});
it('missing credentials leave current configuration and auth unchanged',async()=>{
 const home=await fixture();await rm(join(home,'bridge-providers','chatgpt.auth.json'));
 const before=await readFile(join(home,'config.toml'),'utf8');await expect(switchProvider(home,'chatgpt')).rejects.toThrow('尚未保存');
 expect(await readFile(join(home,'config.toml'),'utf8')).toBe(before);expect((await getProviderStatus(home)).mode).toBe('api');
});
it('mismatched target credentials are rejected',async()=>{
 const home=await fixture();await writeFile(join(home,'bridge-providers','chatgpt.auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'wrong'}));
 await expect(switchProvider(home,'chatgpt')).rejects.toThrow('不匹配');expect((await getProviderStatus(home)).mode).toBe('api');
});
it('recovers interrupted pair writes before a new switch',async()=>{
 const home=await fixture();const config=await readFile(join(home,'config.toml'),'utf8');const auth=await readFile(join(home,'auth.json'),'utf8');
 await writeFile(join(home,'bridge-providers','pending.json'),JSON.stringify({config,auth}));
 await writeFile(join(home,'auth.json'),await readFile(join(home,'bridge-providers','chatgpt.auth.json')));
 await expect(switchProvider(home,'api')).resolves.toMatchObject({mode:'api'});
 expect(await readFile(join(home,'auth.json'),'utf8')).toBe(auth);
 await expect(readFile(join(home,'bridge-providers','pending.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('switches without reading or modifying histories, including same-source selection',async()=>{
 const home=await fixture();await mkdir(join(home,'sessions'));const file=join(home,'sessions','old.jsonl');
 const old='malformed or unused history must not be scanned';await writeFile(file,old);
 await switchProvider(home,'api');await switchProvider(home,'chatgpt');
 expect(await readFile(file,'utf8')).toBe(old);expect((await getProviderStatus(home)).mode).toBe('chatgpt');
});
