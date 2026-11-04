import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchPages } from '../lib/tinyfish.js';

const dir = join(process.cwd(), 'tests', 'fixtures');
await mkdir(dir, { recursive: true });

const [company] = await fetchPages(['https://find-and-update.company-information.service.gov.uk/company/00445790'], { ttl: 0 });
await writeFile(join(dir, 'companies-house-tesco.md'), company.text, 'utf8');
console.log('companies house', company.text.length, 'chars');

const [cslb] = await fetchPages(['https://www.cslb.ca.gov/738180'], { ttl: 0 });
await writeFile(join(dir, 'cslb-738180.md'), cslb.text, 'utf8');
const cslbHtml = await fetch('https://www.cslb.ca.gov/738180', {
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; TinyVerify/0.1; licence verification tool)' },
});
await writeFile(join(dir, 'cslb-738180.html'), await cslbHtml.text(), 'utf8');
console.log('cslb markdown/html captured');

const npiUrls = [
  'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1295346773',
  'https://npiregistry.cms.hhs.gov/api/?version=2.1&organization_name=MAYO%20CLINIC&limit=3',
];
const npi = await fetchPages(npiUrls, { format: 'html', ttl: 0 });
for (const [index, page] of npi.entries()) {
  await writeFile(join(dir, `npi-${index}.json`), page.text, 'utf8');
  console.log(`npi-${index}.json`, page.text.length, 'chars');
}
