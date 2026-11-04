const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const r=await fetch('https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',{headers:{'user-agent':UA}});
const h=await r.text();
for(const m of h.matchAll(/<form[\s\S]{0,3000}?<\/form>/gi)){
 const f=m[0];
 console.log('FORM', (f.match(/action="([^"]*)"/i)||[])[1], (f.match(/method="([^"]*)"/i)||[])[1]);
 console.log('INPUTS', [...f.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/gi)].map(x=>x[1]).join(', '));
 console.log('SELECTS', [...f.matchAll(/<select[^>]*name="([^"]+)"/gi)].map(x=>x[1]).join(', '));
}
const idx=h.search(/Business Name/i); console.log('SNIP', h.slice(Math.max(0,idx-500), idx+1500).replace(/\s+/g,' '));
