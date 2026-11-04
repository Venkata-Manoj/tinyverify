import { parseCslbPage } from '../lib/registries/cslb.js';
const r=await fetch('https://www.cslb.ca.gov/738180',{headers:{'user-agent':'Mozilla/5.0'}});
const h=await r.text();
const text=h.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/&[a-z]+;/gi,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
const lines=text.split('\n');
const i=lines.findIndex(l=>/Issue Date/i.test(l));
console.log('INDEX',i);
console.log(JSON.stringify(lines.slice(i-4,i+10),null,1));
console.log('PARSED',JSON.stringify(parseCslbPage(h,{url:'https://www.cslb.ca.gov/738180'}),null,1).slice(0,1200));
