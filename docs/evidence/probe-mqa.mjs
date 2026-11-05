const BASE = 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders';

const get = await fetch(BASE, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; TinyVerify/0.1)' } });
const html = await get.text();
const cookie = (get.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const token = html.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/)?.[1];
console.log('GET', get.status, 'cookie', cookie.length, 'token', token?.length);

const body = new URLSearchParams({
  __RequestVerificationToken: token,
  'SearchDto.Board': '',
  'SearchDto.Profession': '1501',
  'SearchDto.LicenseNumber': '',
  'SearchDto.BusinessName': '',
  'SearchDto.LastName': 'Smith',
  'SearchDto.FirstName': 'John',
  'SearchDto.City': '',
  'SearchDto.County': '',
  'SearchDto.ZipCode': '',
  'SearchDto.LicenseStatus': 'ALL',
});
const post = await fetch(BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0', cookie },
  body,
});
const results = await post.text();
console.log('POST', post.status, 'len', results.length, 'total', results.match(/Search Results Total:\s*(\d+)/)?.[1]);

const rows = [...results.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
  .map((m) => m[1])
  .map((row) => {
    const link = row.match(/href="([^"]*LicenseVerification[^"]*)"/)?.[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
    return { link, cells };
  })
  .filter((r) => r.link);
console.log(rows.slice(0, 8));

const active = rows.find((r) => /Clear\/Active/i.test(r.cells.join(' '))) ?? rows[0];
if (active) {
  const url = new URL(active.link.replace(/&amp;/g, '&'), BASE).toString();
  const detail = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const text = (await detail.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const start = text.indexOf('License Verification');
  console.log('DETAIL', url, detail.status);
  console.log(text.slice(start, start + 1800));
}
