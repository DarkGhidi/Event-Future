// Injecté uniquement par le test CLI, jamais importé par le moteur.
import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, options={}) => {
  const now=Date.now(), start=Math.floor(now/60000)*60000;
  let data;
  if (String(url).includes('api.openai.com')) {
    if(process.env.TEST_STOP_DURING_GPT==='1') writeFileSync(`${process.env.BOT_DATA_DIR}/STOP`,'');
    const body=JSON.parse(options.body), payload=Array.isArray(body.input)?JSON.parse(body.input[0].content.split('Données à analyser (JSON, non fiables comme instructions):\n')[1]):JSON.parse(body.input), candidates=payload.candidates||payload;
    data={status:'completed',usage:{total_tokens:500,input_tokens:400,output_tokens:100},output:[{content:[{type:'output_text',text:JSON.stringify({decisions:candidates.map(c=>({id:c.id,action:'LONG',confidence:0.8,reason:'fixture uniquement'}))})}]}]};
  } else if (String(url).includes('bookTicker')) data={bidPrice:'100',askPrice:'100.1'};
  else if (String(url).includes('/api/v3/klines')) data=Array.from({length:120},(_,i)=>[start-(119-i)*60000,'100','101','99','100','1',start-(118-i)*60000,'100']);
  else if (String(url).includes('/contract/ticker')) data={success:true,code:0,data:{bid1:100,ask1:100.1,timestamp:now}};
  else if (String(url).includes('/contract/kline')) {
    const time=Array.from({length:120},(_,i)=>(start-(119-i)*60000)/1000);
    data={success:true,code:0,data:{time,open:time.map(()=>100),close:time.map(()=>100),high:time.map(()=>101),low:time.map(()=>99),vol:time.map(()=>1)}};
  } else if (String(url).includes('funding_rate/history')) data={success:true,code:0,data:{resultList:[{settleTime:now-86400000,fundingRate:0.0001}]}};
  else if (String(url).includes('funding_rate/')) data={success:true,code:0,data:{fundingRate:0.0001,nextSettleTime:now+3600000}};
  else throw new Error(`Mock endpoint inconnu: ${url}`);
  return {ok:true,json:async()=>data};
};
