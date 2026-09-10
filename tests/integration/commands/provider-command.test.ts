import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tryHandleCommand, runCommandHandler, type CommandContext } from '../../../src/commands';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createFakeChannel } from '../../helpers/fake-channel';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(content='/provider',chatType='p2p',senderId='owner'){
 const root=await mkdtemp(join(tmpdir(),'provider-command-'));dirs.push(root);const home=join(root,'profiles','goblin-codex','provider-codex-home');await mkdir(home,{recursive:true});
 await writeFile(join(home,'config.toml'),'model_provider="OpenAI"\n[model_providers.OpenAI]\nbase_url="https://token.brioi.com"\n');
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fake-secret'}));
 await mkdir(join(home,'bridge-providers'));
 await writeFile(join(home,'bridge-providers','chatgpt.auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-token'}}));
 const profile=createDefaultProfileConfig({agentKind:'codex',codex:{binaryPath:'codex',codexHome:home},accounts:{app:{id:'app',secret:'fake',tenant:'feishu'}},access:{admins:['owner']}});
 profile.codex={binaryPath:'codex',codexHome:home};
 const channel=createFakeChannel();const activeRuns=new ActiveRuns();
 const ctx={channel,msg:{content,chatId:'chat',chatType,senderId},chatMode:chatType,agent:{id:'codex'},activeRuns,controls:{profile:'goblin-codex',profileConfig:profile,botOwnerId:'owner',ownerRefreshState:'ok',configPath:join(root,'bridge.json')}} as unknown as CommandContext;
 return {ctx,channel,activeRuns,home,text:()=>JSON.stringify(channel.sent)};
}
it('reports login mode without exposing credentials',async()=>{const h=await fixture();expect(await tryHandleCommand(h.ctx)).toBe(true);expect(h.text()).toContain('API Key');expect(h.text()).not.toContain('fake-secret');});
it('rejects group messages even for owner',async()=>{const h=await fixture('/provider chatgpt','group');await tryHandleCommand(h.ctx);expect(h.text()).toContain('仅限私聊');expect(await readFile(join(h.home,'auth.json'),'utf8')).toContain('fake-secret');});
it('rejects non-admin DMs',async()=>{const h=await fixture('/provider chatgpt','p2p','other');await tryHandleCommand(h.ctx);expect(h.text()).toContain('仅管理员');});
it('group card invocation cannot bypass private restriction',async()=>{const h=await fixture('/provider','group');await runCommandHandler('provider','chatgpt',h.ctx);expect(h.text()).toContain('仅限私聊');});
it('refuses active work in another chat',async()=>{const h=await fixture('/provider chatgpt');h.activeRuns.register('other',{} as never);await tryHandleCommand(h.ctx);expect(h.text()).toContain('正在运行');expect(h.activeRuns.newRunsPaused()).toBe(false);});
it('switches and reports actual new login mode',async()=>{const h=await fixture('/provider chatgpt');await tryHandleCommand(h.ctx);expect(h.text()).toContain('已切换');expect(h.text()).toContain('ChatGPT 账号');expect(h.activeRuns.newRunsPaused()).toBe(false);expect(await readFile(join(h.home,'auth.json'),'utf8')).not.toContain('fake-secret');});

it('never switches shared Codex home',async()=>{const h=await fixture('/provider chatgpt');h.ctx.controls.profileConfig.codex!.codexHome=h.home+'/../shared';await tryHandleCommand(h.ctx);expect(h.text()).toContain('飞书独立');});
it('refuses draining CLI children after ActiveRuns is cleared',async()=>{const h=await fixture('/provider chatgpt');Object.assign(h.ctx.agent,{hasRunningProcesses:()=>true});await tryHandleCommand(h.ctx);expect(h.text()).toContain('正在运行');expect(await readFile(join(h.home,'auth.json'),'utf8')).toContain('fake-secret');});
it('switch command leaves histories untouched',async()=>{
 const h=await fixture('/provider chatgpt');await mkdir(join(h.home,'sessions'));
 const file=join(h.home,'sessions','old.jsonl');await writeFile(file,'unused malformed history');
 await tryHandleCommand(h.ctx);expect(h.text()).toContain('已切换');expect(await readFile(file,'utf8')).toBe('unused malformed history');
});
