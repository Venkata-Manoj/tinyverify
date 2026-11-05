const urls=['https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1295346773','https://npiregistry.cms.hhs.gov/provider-view/1295346773'];
for(const u of urls){
 try{const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','accept':'application/json,text/html'},signal:AbortSignal.timeout(20000)});const t=await r.text();console.log(u,'OK',r.status,t.length,t.slice(0,200));}
 catch(e){console.log(u,'ERR',e.message,'CAUSE',String(e.cause), e.cause?.code);}
}
