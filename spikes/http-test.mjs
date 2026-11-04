const BASE = 'http://localhost:3000';

async function call(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const verifyRes = await call('/api/verify', {
  method: 'POST',
  body: { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
});
console.log('VERIFY', verifyRes.status, verifyRes.data.match_quality, verifyRes.data.primary?.status, verifyRes.data.primary?.licence_number, verifyRes.data.primary?.checked_at);
console.log('searched', JSON.stringify(verifyRes.data.searched));

const createRes = await call('/api/monitors', {
  method: 'POST',
  body: { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
});
console.log('CREATE', createRes.status, JSON.stringify(createRes.data).slice(0, 900));
const id = createRes.data?.monitor?.id;

if (id) {
  const listRes = await call('/api/monitors');
  console.log('LIST', listRes.status, listRes.data.monitors?.length, listRes.data.monitors?.[0]?.id);

  const getRes = await call(`/api/monitors/${id}`);
  console.log('GET', getRes.status, 'events', getRes.data.events?.length, 'snapshot', JSON.stringify(getRes.data.monitor?.snapshot));

  const started = Date.now();
  const checkRes = await call(`/api/monitors/${id}/check`, { method: 'POST' });
  console.log('CHECK', checkRes.status, `${Date.now() - started}ms`, 'event:', checkRes.data.event, 'note:', checkRes.data.note, 'tinyfish:', JSON.stringify(checkRes.data.monitor?.last_tinyfish_run));
  console.log('after snapshot', JSON.stringify(checkRes.data.monitor?.snapshot));

  const delRes = await call(`/api/monitors/${id}`, { method: 'DELETE' });
  console.log('DELETE', delRes.status, JSON.stringify(delRes.data));
}

const badRes = await call('/api/verify', { method: 'POST', body: { subject: '', licence_type: 'business', jurisdiction: 'UK' } });
console.log('BAD', badRes.status, JSON.stringify(badRes.data));
const unsupported = await call('/api/verify', { method: 'POST', body: { subject: 'Test Doctor', licence_type: 'medical', jurisdiction: 'NZ' } });
console.log('UNSUPPORTED', unsupported.status, unsupported.data.match_quality, unsupported.data.notes);
