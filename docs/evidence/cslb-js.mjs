const r=await fetch('https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',{headers:{'user-agent':'Mozilla/5.0'}});
const h=await r.text();
const urls=[...new Set([...h.matchAll(/(?:href|action|location(?:\.href)?\s*=|url\s*[:=]\s*)["']?([^"'\s>]*\.aspx[^"'\s>]*)/gi)].map(m=>m[1]))];
console.log('ASPX',urls.filter(u=>/check|license|business|name|search/i.test(u)));
for(const fn of ['BusinessNameSearchClick','LicenseNumberSearchClick','PersonnelNameSearchClick']){
 const i=h.indexOf('function '+fn); console.log('\n'+fn, i, h.slice(i,i+600).replace(/\s+/g,' '));
}
const i=h.indexOf('BusinessName'); console.log('\nCTX',h.slice(i-500,i+1200).replace(/\s+/g,' '));
