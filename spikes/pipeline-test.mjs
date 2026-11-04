import { verify } from '../lib/verify.js';

const cases = [
  { label: 'Tesco PLC / business / UK (exact)', input: { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' } },
  { label: 'Tesco / business / UK (ambiguous)', input: { subject: 'Tesco', licence_type: 'business', jurisdiction: 'UK' } },
  { label: 'Fake company / business / UK (no match)', input: { subject: 'Zzzqqq Not A Real Company 9988', licence_type: 'business', jurisdiction: 'UK' } },
  { label: 'HALA TREE SERVICE / contractor / US-CA', input: { subject: 'HALA TREE SERVICE', licence_type: 'contractor', jurisdiction: 'US-CA' } },
  { label: 'DONE RIGHT DISCOUNT FLOORING / contractor / US-CA', input: { subject: 'DONE RIGHT DISCOUNT FLOORING', licence_type: 'contractor', jurisdiction: 'US-CA' } },
  { label: 'Mayo Clinic / health / US (ambiguous)', input: { subject: 'Mayo Clinic', licence_type: 'health', jurisdiction: 'US' } },
  { label: 'Planise Jean Louis / health / US', input: { subject: 'Planise Jean Louis', licence_type: 'health', jurisdiction: 'US' } },
  { label: 'Fake NPI / health / US (no match)', input: { subject: 'Fake Provider', licence_type: 'health', jurisdiction: 'US', number: '1234567893' } },
];

for (const testCase of cases) {
  const started = Date.now();
  try {
    const r = await verify(testCase.input, { refresh: true });
    console.log('\n====', testCase.label, `(${Date.now() - started}ms) ====`);
    console.log('quality:', r.match_quality, '| primary:', r.primary?.status, r.primary?.licence_number, r.primary?.matched_name);
    console.log('candidates:', r.candidates?.length, '| results:', r.results?.length, '| notes:', r.notes?.slice(0, 3));
    if (r.primary) console.log('record:', JSON.stringify({ status: r.primary.status, no: r.primary.licence_number, exp: r.primary.expiry_date, disc: r.primary.disciplinary_actions, src: r.primary.source_url, fields: r.primary.fields }, null, 1).slice(0, 1400));
    if (r.candidates?.length) console.log('first candidates:', r.candidates.slice(0, 3).map(c => `${c.name} (${c.licence_number}) ${c.status}`));
  } catch (err) {
    console.log('\n====', testCase.label, 'FAILED ====');
    console.log(err.stack || String(err));
  }
}
