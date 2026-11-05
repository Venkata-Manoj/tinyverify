const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const searchUrl = 'https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies/search?q=air+new+zealand&entityTypes=ALL&entityStatusGroups=ALL&start=0&limit=15&advancedPanel=true&mode=advanced';
const recordUrl = 'https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies/104799';

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th|dt|dd|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

for (const [label, url] of [['SEARCH', searchUrl], ['RECORD', recordUrl], ['SHORT', 'https://app.companiesoffice.govt.nz/co/104799']]) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    console.log(`\n===== ${label} ${res.status} ${res.url} bytes=${html.length} =====`);
    const text = textOf(html);
    const markers = ['AIR NEW ZEALAND', 'Company number', 'NZBN', 'Incorporation', 'Company Status', 'Registered Office', 'AR filing', 'Last updated'];
    for (const marker of markers) {
      const index = text.indexOf(marker);
      if (index >= 0) console.log(`[${marker}] ${JSON.stringify(text.slice(index, index + 220))}`);
    }
    if (label === 'SEARCH') {
      const names = [...html.matchAll(/class="[^"]*entityName[^"]*"[^>]*>([\s\S]*?)<\//gi)].map((m) => textOf(m[1])).slice(0, 10);
      console.log('NAMES', names);
      console.log('LINKS', [...new Set([...html.matchAll(/href="([^"]*companies\/\d+[^"]*)"/gi)].map((m) => m[1]))].slice(0, 10));
    } else {
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      console.log('TITLE', title);
    }
  } catch (err) {
    console.log(label, 'ERROR', err.message, err.cause?.code);
  }
}
