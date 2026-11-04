const r=await fetch('https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',{headers:{'user-agent':'Mozilla/5.0'}});
const h=await r.text();
for(const m of h.matchAll(/<form[^>]*SearchResult[^>]*>[\s\S]{0,1200}?<\/form>/gi)){console.log('FORM:',m[0].replace(/\s+/g,' '));}
let i=h.indexOf('SearchResult.aspx'); while(i>=0 && i<h.length){console.log('CTX',h.slice(Math.max(0,i-300),i+500).replace(/\s+/g,' ')); i=h.indexOf('SearchResult.aspx',i+1); if(i>20000)break;}
