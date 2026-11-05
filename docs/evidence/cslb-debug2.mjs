const r=await fetch('https://www.cslb.ca.gov/738180',{headers:{'user-agent':'Mozilla/5.0'}});
const h=await r.text();
const text=h.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/&[a-z]+;/gi,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
let idx=-1,count=0;
while((idx=text.indexOf('Issue Date',idx+1))>=0 && count<10){console.log('AT',idx,JSON.stringify(text.slice(idx,idx+80)));count++;}
console.log('REGEX', JSON.stringify(text.match(/Issue Date\s*\n+([^\n]+)/i)));
