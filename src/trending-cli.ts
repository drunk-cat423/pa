import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {readConfig} from './config.js';
import {readQQSettings} from './qq-config.js';
import {collectTrending,generateTrendingDigest,TrendingContentError} from './trending-content.js';
import {TrendingStore} from './trending-store.js';

async function main():Promise<void>{
  const [command,id,...extra]=process.argv.slice(2);
  if(extra.length||!['preview','request-test','status'].includes(command??'')
    ||(command==='preview'&&id)||(command==='request-test'&&!id)
    ||(id&&!/^[a-zA-Z0-9_-]{1,80}$/.test(id)))throw new Error('用法：trending-cli.js preview | request-test <唯一编号> | status [手工编号]');
  const config=readConfig();
  if(command==='preview'){
    const snapshot=await collectTrending(config),digest=await generateTrendingDigest(config,snapshot);
    console.log(digest.sections.map(s=>s.text).join('\n\n'));return;
  }
  const path=join(config.dataDir,'trending.sqlite');
  if(command==='status'&&!existsSync(path)){console.log(JSON.stringify({state:'not_initialized'}));return;}
  const store=new TrendingStore(path);
  try{
    if(command==='request-test'){
      if(!config.trending?.enabled)throw new Error('Trending 未启用，未安排试发。');
      const routes=readQQSettings().routes.filter(r=>r.roomType==='group'&&config.trending!.groupIds.includes(r.roomId));
      if(routes.length!==config.trending.groupIds.length)throw new Error('试发群配置不匹配。');
      const e=store.requestManual(id!,routes);
      console.log(JSON.stringify({id:e.id,state:e.state,groups:e.routes.length,notice:'由运行中的PA服务生成并发送；不会建立第二个QQ连接。'}));return;
    }
    const e=id?store.get(`manual:${id}`):store.latest();
    console.log(JSON.stringify(e?{id:e.id,date:e.date,state:e.state,code:e.code,attempts:e.attempts,
      groups:e.routes.map((r,index)=>({index,parts:store.parts(e.id,r).map(p=>({index:p.index,status:p.status}))})),updatedAt:new Date(e.updatedAt).toISOString()}: {state:'not_found'},null,2));
  }finally{store.close();}
}
void main().catch(error=>{console.error(error instanceof TrendingContentError?`${error.code}: ${error.message}`:'Trending 操作未完成；请检查命令、配置和本地诊断记录。');process.exitCode=1;});
