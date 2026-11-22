// Daily Log -> Google Health sync. Paste into the Worker editor and Deploy.
// Needs: KV binding STORE; secrets/variables CLIENT_ID, CLIENT_SECRET, APP_KEY.
const SCOPE='https://www.googleapis.com/auth/googlehealth.nutrition.writeonly';
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
  if(u.pathname==='/sync'&&req.method==='POST'){
    try{
      const {date,entries}=await req.json(),tok=await accessToken(env),prev=JSON.parse((await env.STORE.get('day:'+date))||'[]');
      let deleted=0,delErr='';
      if(prev.length){const r=await fetch(API+':batchDelete',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:JSON.stringify({names:prev})});if(r.ok)deleted=prev.length;else delErr=await r.text()}
      const names=[],errors=[];
      for(const e of entries){
        const log={interval:{startTime:e.start,endTime:e.end},foodDisplayName:e.name,energy:{kcal:e.kcal},totalCarbohydrate:{grams:e.carb},totalFat:{grams:e.fat},nutrients:[{nutrient:'PROTEIN',quantity:{grams:e.protein}}],serving:{amount:1}};
        if(e.meal)log.mealType=e.meal;
        let r=await create(tok,{nutritionLog:log});
        if(!r.ok&&r.status===400&&log.mealType){delete log.mealType;r=await create(tok,{nutritionLog:log})}
        if(r.ok){const n=(r.j.response&&r.j.response.name)||r.j.name;if(n)names.push(n)}else errors.push({food:e.name,status:r.status,detail:JSON.stringify(r.j).slice(0,300)});
      }
      await env.STORE.put('day:'+date,JSON.stringify(names));
      return json({date,created:names.length,deleted,errors,delErr:delErr.slice(0,200)});
    }catch(err){return json({error:String(err.message||err)},500)}
  }
  return page('Daily Log sync is running.');
}}
