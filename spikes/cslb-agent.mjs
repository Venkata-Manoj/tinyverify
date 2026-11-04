import { readFileSync } from 'node:fs';
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
          business_name: { type: 'string' },
          licence_number: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['business_name', 'licence_number'],
      },
    },
    page_note: { type: 'string' },
  },
  required: ['found', 'matches'],
};

const goal = `Use the CSLB "Check A License" public tool at this page. Click "Check by Business Name", type "HALA TREE SERVICE" into the business name field, and submit the search. Return up to 10 matching contractor licence numbers and business names exactly as shown in the results. Do not guess or invent a licence number. If the search returns no results or the form cannot be used, set found=false and explain in page_note.`;

const started = Date.now();
const res = await fetch('https://agent.tinyfish.ai/v1/automation/run', {
  method: 'POST',
  headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx', goal, output_schema: schema, agent_config: { max_duration_seconds: 180 } }),
});
const body = await res.json();
console.log(JSON.stringify({ ms: Date.now() - started, http: res.status, status: body.status, steps: body.num_of_steps, result: body.result, error: body.error }, null, 2));
