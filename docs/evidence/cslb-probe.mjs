const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const urls=[
 'https://www.cslb.ca.gov/1',
 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=1',
 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=738180',
 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=1000000',
 'https://register.nmc.org.uk/',
 'https://www.nmc.org.uk/registration/check-the-register/'
];
for(const u of urls){
 try{
  const r=await fetch(u,{headers:{'user-agent':UA},redirect:'follow',signal:AbortSignal.timeout(25000)});
  const t=await r.text();
  const text=t.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
  console.log(JSON.stringify({u,status:r.status,final:r.url,bytes:t.length,title:(t.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]?.trim(),snippet:text.slice(0,500)}));
 }catch(e){console.log(JSON.stringify({u,error:String(e)}));}
}
