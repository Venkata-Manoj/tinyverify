const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
for(const u of ['https://www.cslb.ca.gov/1','https://www.cslb.ca.gov/738180','https://www.cslb.ca.gov/1000000']){
 const r=await fetch(u,{headers:{'user-agent':UA},signal:AbortSignal.timeout(25000)});
 const t=await r.text();
 const text=t.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,'\n').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#\d+;/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
 const idx=text.search(/License Status|License Number|Expire|Expiration/i);
 console.log('\n====',u,r.status,'====');
 console.log(text.slice(Math.max(0,idx-400), idx+2200));
}
