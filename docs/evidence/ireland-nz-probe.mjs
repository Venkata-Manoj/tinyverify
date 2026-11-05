// Probe: ASP.NET WebForms search (Ireland Medical Council) + NZ Companies Office detail page.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function hiddenFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]*)"/i) ?? [])[1];
    const value = (tag.match(/value="([^"]*)"/i) ?? [])[1] ?? '';
    if (name) out[name] = value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  }
  return out;
}

// --- Ireland ---
const base = 'https://www.medicalcouncil.ie/registration/check-the-register/';
const page = await fetch(base, { headers: { 'user-agent': UA } });
const html = await page.text();
const cookies = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('IE GET', page.status, 'cookies:', cookies.length, 'viewstate:', !!html.match(/__VIEWSTATE/));

const body = new URLSearchParams();
for (const [k, v] of Object.entries(hiddenFields(html))) body.set(k, v);
body.set('ctl00$ctl00$ContentPlaceHolder_Main$ContextGroups$txtSURNAME', 'Basso');
body.set('ctl00$ctl00$ContentPlaceHolder_Main$ContextGroups$txtForename', '');
body.set('ctl00$ctl00$ContentPlaceHolder_Main$ContextGroups$txtREGNUM', '');
body.set('ctl00$ctl00$ContentPlaceHolder_Main$ContextGroups$btnSearch', 'Search');
body.set('ctl00$ctl00$txtSearchTerms', '');

const post = await fetch(base, {
  method: 'POST',
  headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', ...(cookies ? { cookie: cookies } : {}) },
  body,
  redirect: 'follow',
});
const out = await post.text();
console.log('IE POST', post.status, 'bytes', out.length, 'basso:', /basso/i.test(out), 'table:', /<table/i.test(out));
const rows = [...out.matchAll(/<tr[\s\S]{0,2000}?<\/tr>/gi)].map((m) => m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter((t) => /basso|09542/i.test(t));
console.log('IE ROWS:', JSON.stringify(rows.slice(0, 5), null, 1));
const idx = out.search(/basso/i);
if (idx > 0) console.log('IE SNIP:', out.slice(idx - 600, idx + 900).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

// --- NZ Companies ---
const nzSearch = await fetch('https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies/search?q=air+new+zealand', { headers: { 'user-agent': UA } });
const nzHtml = await nzSearch.text();
const links = [...nzHtml.matchAll(/href="([^"]*\/companies\/app\/ui\/pages\/companies\/\d+[^"]*)"/gi)].map((m) => m[1]);
console.log('NZ SEARCH', nzSearch.status, 'company links:', links.slice(0, 5));
if (links[0]) {
  const detailUrl = new URL(links[0], 'https://app.companiesoffice.govt.nz').href;
  const d = await fetch(detailUrl, { headers: { 'user-agent': UA } });
  const dh = await d.text();
  console.log('NZ DETAIL', d.status, detailUrl, 'bytes', dh.length);
  const text = dh.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const at = text.search(/Company status|NZBN|Registration date/i);
  console.log('NZ TEXT:', text.slice(Math.max(0, at - 300), at + 1800));
}
