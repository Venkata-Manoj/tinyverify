// Probe: can TinyFish Agent drive the JS/Cloudflare-protected registries and return structured JSON?
import { readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.TINYFISH_API_KEY;

const schema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          registration_number: { type: 'string' },
          profession: { type: 'string' },
          status: { type: 'string' },
          expiry_date: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name', 'registration_number', 'status'],
      },
    },
    page_note: { type: 'string' },
  },
  required: ['found', 'matches'],
};

const cases = [
  {
    id: 'ahpra',
    url: 'https://www.ahpra.gov.au/Register_Search.aspx',
    goal: 'Use the public Register of practitioners search. Search for practitioners with the surname "Smith" (profession: Medical Practitioner if a profession must be chosen). Return the first 5 matches with their full name, registration number, profession, registration status, and expiry date exactly as shown. If the page shows a CAPTCHA or blocks the search, set found=false and explain in page_note.',
  },
  {
    id: 'hcpc',
    url: 'https://www.hcpc-uk.org/check-the-register/',
    goal: 'Use the Check the Register search. Search for surname "Smith" with the profession "Occupational therapist". Return the first 5 matches with full name, registration number, profession, registration status, and expiry date exactly as shown. If no profession selector is available, search by surname alone. If blocked, set found=false and explain in page_note.',
  },
  {
    id: 'gmc',
    url: 'https://www.gmc-uk.org/registration-and-licensing/our-registers',
    goal: 'Use the GMC "Search our registers" tool. Search for the surname "Smith" (doctors). Return the first 5 matches with full name, GMC reference number, profession, registration status, and any registration expiry/valid-until date exactly as shown. If blocked, set found=false and explain in page_note.',
  },
];

const results = await Promise.all(cases.map(async (c) => {
  const started = Date.now();
  try {
    const res = await fetch('https://agent.tinyfish.ai/v1/automation/run', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: c.url, goal: c.goal, output_schema: schema, agent_config: { max_duration_seconds: 180 } }),
    });
    const body = await res.json();
    return { id: c.id, ms: Date.now() - started, http: res.status, status: body.status, steps: body.num_of_steps, result: body.result, error: body.error };
  } catch (err) {
    return { id: c.id, ms: Date.now() - started, error: String(err) };
  }
}));
console.log(JSON.stringify(results, null, 2));
writeFileSync('spikes/agent-registries.json', JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2));
