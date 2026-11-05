const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
for(const q of ['DONE RIGHT DISCOUNT FLOORING','HALA TREE SERVICE']){
 const u='https://www.cslb.ca.gov/SearchResult.aspx?q='+encodeURIComponent(q);
 const r=await fetch(u,{headers:{'user-agent':UA},signal:AbortSignal.timeout(25000)});
 const h=await r.text();
 const text=h.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,'\n').replace(/&nbsp;/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
 console.log('\n====',q,r.status,r.url,'bytes',h.length,'====');
 console.log(text.slice(0,1800));
 console.log('LINKS', [...new Set([...h.matchAll(/href="(\/\d+|\/OnlineServices\/CheckLicenseII\/[^"]+)"/gi)].map(m=>m[1]))].slice(0,15).join(' | '));
}
