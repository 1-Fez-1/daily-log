// Daily Log -> Google Health sync. Paste into the Worker editor and Deploy.
// Needs: KV binding STORE; secrets/variables CLIENT_ID, CLIENT_SECRET, APP_KEY.
const SCOPE='https://www.googleapis.com/auth/googlehealth.nutrition.writeonly https://www.googleapis.com/auth/googlehealth.nutrition.readonly';
const API='https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'X-Key, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'};
const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const page=t=>new Response('<meta name=viewport content="width=device-width,initial-scale=1"><body style="font:18px system-ui;padding:24px">'+t,{headers:{'Content-Type':'text/html'}});
async function accessToken(env){
  const rt=await env.STORE.get('refresh');if(!rt)throw new Error('Not connected. Tap Connect in the app.');
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.CLIENT_ID,client_secret:env.CLIENT_SECRET,refresh_token:rt,grant_type:'refresh_token'})});
  const j=await r.json();if(!r.ok||!j.access_token)throw new Error('Google sign-in expired or was refused ('+(j.error||r.status)+'). Tap Connect again.');
  return j.access_token;
}
async function unitName(env,tok){
  const c=await env.STORE.get('unit');if(c)return c;
  const r=await fetch('https://health.googleapis.com/v4/users/me/dataTypes/food-measurement-unit/dataPoints?pageSize=200',{headers:{Authorization:'Bearer '+tok}});
  const j=await r.json().catch(()=>({})),a=j.dataPoints||j.data_points||[];
  const pick=a.find(x=>/piece/i.test(JSON.stringify(x)))||a.find(x=>/serving/i.test(JSON.stringify(x)))||a[0];
  const n=pick&&(pick.name||(pick.foodMeasurementUnit&&pick.foodMeasurementUnit.name));
  if(!n)throw new Error('Could not find a measurement unit: '+JSON.stringify(j).slice(0,300));
  await env.STORE.put('unit',n);return n;
}
async function delNames(tok,names){
  let ok=0,failed=[];
  for(let i=0;i<names.length;i+=50){
    const chunk=names.slice(i,i+50);
    let r=await fetch(API+':batchDelete',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:JSON.stringify({names:chunk})});
    if(r.ok){ok+=chunk.length;continue}
    for(const n of chunk){
      r=await fetch(API+':batchDelete',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:JSON.stringify({names:[n]})});
      if(r.ok)ok++;else failed.push(n)
    }
  }
  return {ok,failed};
}
async function listAll(tok){
  const out=[];let pt='';
  for(let i=0;i<30;i++){
    const r=await fetch(API+'?page_size=1000'+(pt?'&page_token='+encodeURIComponent(pt):''),{headers:{Authorization:'Bearer '+tok}});
    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error('List failed: '+JSON.stringify(j).slice(0,200));
    (j.dataPoints||[]).forEach(d=>out.push(d));pt=j.nextPageToken||'';if(!pt)break;
  }
  return out;
}
async function create(tok,body){
  const r=await fetch(API,{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {ok:r.ok,status:r.status,j:await r.json().catch(()=>({}))};
}
export default{async fetch(req,env){
  const u=new URL(req.url);
  if(req.method==='OPTIONS')return new Response(null,{headers:cors});
  const redirect=u.origin+'/callback';
  if(u.pathname==='/connect'){
    if(u.searchParams.get('key')!==env.APP_KEY)return page('Wrong key.');
    const g=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    g.search=new URLSearchParams({client_id:env.CLIENT_ID,redirect_uri:redirect,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state:env.APP_KEY.slice(0,8)});
    return Response.redirect(g.toString(),302);
  }
  if(u.pathname==='/callback'){
    if(u.searchParams.get('state')!==env.APP_KEY.slice(0,8))return page('Bad state.');
    const code=u.searchParams.get('code');if(!code)return page('Google said: '+(u.searchParams.get('error')||'no code'));
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.CLIENT_ID,client_secret:env.CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code'})});
    const j=await r.json();
    if(!j.refresh_token)return page('No refresh token received: '+(j.error_description||j.error||'unknown'));
    await env.STORE.put('refresh',j.refresh_token);await env.STORE.put('connectedAt',String(Date.now()));
    return page('Connected to Google Health. You can close this and go back to Daily Log.');
  }
  if(req.headers.get('X-Key')!==env.APP_KEY)return json({error:'Wrong key'},401);
  if(u.pathname==='/status'){return json({connected:!!(await env.STORE.get('refresh')),at:+(await env.STORE.get('connectedAt'))||0})}
  if(u.pathname==='/backup'){
    if(req.method==='POST'){
      const body=await req.text();if(body.length<20||body.length>20000000)return json({error:'Bad backup'},400);
      const cur=await env.STORE.get('backup'),meta=JSON.parse((await env.STORE.get('backupMeta'))||'{}');
      if(cur&&Date.now()-(meta.at||0)>20*3600*1000){await env.STORE.put('backup:prev',cur);await env.STORE.put('backupMeta:prev',JSON.stringify(meta))}
      await env.STORE.put('backup',body);const at=Date.now();await env.STORE.put('backupMeta',JSON.stringify({at,size:body.length}));
      return json({ok:true,at,size:body.length});
    }
    const old=u.searchParams.get('prev')==='1',data=await env.STORE.get(old?'backup:prev':'backup');
    if(!data)return json({error:'No backup saved yet'},404);
    return json({at:(JSON.parse((await env.STORE.get(old?'backupMeta:prev':'backupMeta'))||'{}')).at||0,data});
  }
  if(u.pathname==='/inspect'&&req.method==='POST'){
    try{
      const {from,to}=await req.json(),tok=await accessToken(env),all=await listAll(tok);
      const rows=all.map(d=>{const n=d.nutritionLog||{},iv=n.interval||{};return {id:String(d.name||'').split('/').pop(),food:n.foodDisplayName||(n.food?'(food db)':''),kcal:n.energy&&n.energy.kcal,meal:n.mealType||'',start:iv.startTime||'',civil:iv.civilStartTime||null,src:(d.dataSource&&(d.dataSource.platform||''))+(d.dataSource&&d.dataSource.application?'/'+JSON.stringify(d.dataSource.application).slice(0,40):'')}}).filter(x=>x.start>=from&&x.start<to);
      return json({total:all.length,rows});
    }catch(err){return json({error:String(err.message||err)},500)}
  }
  if(u.pathname==='/cleanup'&&req.method==='POST'){
    try{
      const tok=await accessToken(env),all=await listAll(tok);
      const mine=all.filter(d=>!d.dataSource||!d.dataSource.platform||d.dataSource.platform==='GOOGLE_WEB_API').map(d=>d.name).filter(Boolean);
      const res=await delNames(tok,mine);
      let k=await env.STORE.list({prefix:'day:'});for(const x of k.keys)await env.STORE.delete(x.name);
      return json({found:all.length,deleted:res.ok,failed:res.failed.length});
    }catch(err){return json({error:String(err.message||err)},500)}
  }
  if(u.pathname==='/sync'&&req.method==='POST'){
    try{
      const {date,entries}=await req.json(),lk=await env.STORE.get('lock:'+date);
      if(lk&&Date.now()-(+lk)<45000)return json({error:'Another sync for this day is running. Try again shortly.'},409);
      await env.STORE.put('lock:'+date,String(Date.now()),{expirationTtl:60});
      const tok=await accessToken(env),unit=await unitName(env,tok),prev=JSON.parse((await env.STORE.get('day:'+date))||'[]');
      let deleted=0,delErr='',keep=[];
      if(prev.length){const d=await delNames(tok,prev);deleted=d.ok;keep=d.failed;if(d.failed.length)delErr=d.failed.length+' old entries could not be removed'}
      const names=[...keep],errors=[];
      for(const e of entries){
        const off=typeof e.off==='number'?e.off+'s':null,log={interval:Object.assign({startTime:e.start,endTime:e.end},off?{startUtcOffset:off,endUtcOffset:off}:{}),foodDisplayName:e.name,energy:{kcal:e.kcal},totalCarbohydrate:{grams:e.carb},totalFat:{grams:e.fat},nutrients:[{nutrient:'PROTEIN',quantity:{grams:e.protein}}],serving:{amount:1,foodMeasurementUnit:unit}};
        if(e.meal)log.mealType=e.meal;
        let r=await create(tok,{nutritionLog:log});
        if(!r.ok&&r.status===400&&log.mealType){delete log.mealType;r=await create(tok,{nutritionLog:log})}
        if(!r.ok&&r.status===400&&off){delete log.interval.startUtcOffset;delete log.interval.endUtcOffset;r=await create(tok,{nutritionLog:log})}
        if(r.ok){const n=(r.j.response&&r.j.response.name)||r.j.name;if(n)names.push(n)}else errors.push({food:e.name,status:r.status,detail:JSON.stringify(r.j).slice(0,300)});
      }
      await env.STORE.put('day:'+date,JSON.stringify(names));await env.STORE.delete('lock:'+date);
      return json({date,created:names.length,deleted,errors,delErr:delErr.slice(0,200)});
    }catch(err){return json({error:String(err.message||err)},500)}
  }
  return page('Daily Log sync is running.');
}}
