// Phase 1: probe candidate registry pages with plain HTTP to find server-rendered search paths.
const candidates = [
  ['gmc_registers', 'https://www.gmc-uk.org/registration-and-licensing/our-registers'],
  ['gmc_search_guess', 'https://www.gmc-uk.org/registration-and-licensing/our-registers/search?query=Smith'],
  ['hcpc_check', 'https://www.hcpc-uk.org/check-the-register/'],
  ['hcpc_search_guess', 'https://www.hcpc-uk.org/check-the-register/?surname=Smith'],
  ['ireland_reg', 'https://www.medicalcouncil.ie/registration/check-the-register/?DoSearch=TRUE&CONNUM=09542'],
  ['ireland_public', 'https://www.medicalcouncil.ie/public-information/check-the-register/'],
  ['ahpra', 'https://www.ahpra.gov.au/Register_Search.aspx'],
  ['npi_api', 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1234567893'],
  ['ch_search', 'https://find-and-update.company-information.service.gov.uk/search/companies?q=tesco'],
  ['nz_companies', 'https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies/search?q=air+new+zealand'],
];

for (const [name, url] of candidates) {
  try {
    const started = Date.now();
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    const forms = [...html.matchAll(/<form[^>]*>/gi)].map((m) => m[0]).slice(0, 6);
    const inputs = [...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
    const selects = [...html.matchAll(/<select[^>]*name="([^"]+)"/gi)].map((m) => m[1]);
    console.log(JSON.stringify({
      name, status: res.status, final: res.url, ms: Date.now() - started, bytes: html.length,
      title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1]?.trim(),
      forms, inputs: [...new Set(inputs)].slice(0, 20), selects,
      hasTable: /<table/i.test(html), hasResultWord: /result|registered|active|expired/i.test(html),
      cloudflare: /cloudflare|just a moment|captcha/i.test(html),
    }));
    if (name === 'ireland_reg') {
      const idx = html.search(/basso/i);
      console.log('IRELAND_SNIP:', idx >= 0 ? html.slice(Math.max(0, idx - 1200), idx + 1600).replace(/\s+/g, ' ') : 'NO NAME ON PAGE');
      console.log('IRELAND_TABLE:', (html.match(/<table[\s\S]{0,3000}?<\/table>/i) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 2500));
    }
    if (name === 'gmc_registers') {
      console.log('GMC_SNIP:', html.slice(html.search(/Search our registers/i), html.search(/Search our registers/i) + 3000).replace(/\s+/g, ' ').slice(0, 2500));
    }
  } catch (err) {
    console.log(JSON.stringify({ name, error: String(err) }));
  }
}
