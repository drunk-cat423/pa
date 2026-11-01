import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {readConfig} from './config.js';
import {readQQSettings} from './qq-config.js';
import {collectTrending,generateTrendingDigest,formatTrendingParts,TrendingContentError} from './trending-content.js';
import {TrendingStore} from './trending-store.js';

async function main():Promise<void>{
  const [command,id,...extra]=process.argv.slice(2);
  if(extra.length||!['preview','request-test','request-ai','recover','status'].includes(command??'')
    ||(command==='preview'&&id)||(['request-test','request-ai','recover'].includes(command??'')&&!id)
    ||(id&&!/^[a-zA-Z0-9_-]{1,80}$/.test(id)))throw new Error('用法：trending-cli.js preview | request-test <唯一编号> | recover YYYY-MM-DD | request-ai YYYY-MM-DD | status [手工编号]');
  const config=readConfig();
  if(command==='preview'){
    const snapshot=await collectTrending(config),digest=await generateTrendingDigest(config,snapshot);
    const date=new Date(Date.parse(snapshot.fetchedAt)+8*60*60_000).toISOString().slice(0,10);
    console.log(JSON.stringify({parts:formatTrendingParts(digest,{date})},null,2));return;
  }
  const path=join(config.dataDir,'trending.sqlite');
  if(command==='status'&&!existsSync(path)){console.log(JSON.stringify({state:'not_initialized'}));return;}
  const store=new TrendingStore(path);
  try{
    if(command==='request-ai'){
      if(!config.trending?.enabled)throw new Error('Trending 未启用，未安排AI总结补充。');
      const e=store.requestAiSupplement(id!);
      console.log(JSON.stringify({id:e.id,state:e.state,supplementOf:e.supplementOf,notice:'由运行中的PA服务使用原快照和原群路由生成AI总结补充；保留原正式期回执。'}));return;
    }
    if(command==='recover'){
      if(!config.trending?.enabled)throw new Error('Trending 未启用，未安排恢复。');
      const e=store.requestRecovery(id!);
      console.log(JSON.stringify({id:e.id,state:e.state,recovery:e.recovery,notice:'由运行中的PA服务使用原快照和原群路由补齐AI总结后发送正式日报；显式追加一次3次模型调用预算。'}));return;
    }
    if(command==='request-test'){
      if(!config.trending?.enabled)throw new Error('Trending 未启用，未安排试发。');
      const routes=readQQSettings().routes.filter(r=>r.roomType==='group'&&config.trending!.groupIds.includes(r.roomId));
      if(routes.length!==config.trending.groupIds.length)throw new Error('试发群配置不匹配。');
      const e=store.requestManual(id!,routes);
      console.log(JSON.stringify({id:e.id,state:e.state,groups:e.routes.length,notice:'由运行中的PA服务生成并发送；不会建立第二个QQ连接。'}));return;
    }
    const e=id?store.get(`manual:${id}`):store.latest();
    console.log(JSON.stringify(e?{id:e.id,date:e.date,state:e.state,code:e.code,attempts:e.attempts,generation:e.generation?{attempts:e.generation.attempts,limit:e.generation.limit,completed:Object.keys(e.generation.introductions).length}:undefined,supplementOf:e.supplementOf,degraded:e.digest?.degraded,recovery:e.recovery,
      groups:e.routes.map((r,index)=>({index,parts:store.parts(e.id,r).map(p=>({index:p.index,status:p.status}))})),updatedAt:new Date(e.updatedAt).toISOString()}: {state:'not_found'},null,2));
  }finally{store.close();}
}
void main().catch(error=>{console.error(error instanceof TrendingContentError?`${error.code}: ${error.message}`:'Trending 操作未完成；请检查命令、配置和本地诊断记录。');process.exitCode=1;});
