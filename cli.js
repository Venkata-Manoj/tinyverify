#!/usr/bin/env node
import { verify } from './lib/verify.js';
import { checkWatch, createWatch, deleteWatch, getWatch, listWatches } from './lib/monitors.js';
import { coverageMatrix, listRegistryMetadata } from './lib/registry.js';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';

function flag(name, fallback = undefined) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const USAGE = `TinyVerify CLI

  node cli.js verify <name> --type business --jurisdiction UK [--number 00445790] [--json]
  node cli.js registries
  node cli.js monitors
  node cli.js monitor <id>
  node cli.js watch <name> --type business --jurisdiction UK [--number 00445790]
  node cli.js check <id>
  node cli.js unwatch <id>

Types: business, contractor, health
Jurisdictions: UK, US, US-CA
`;

function printRecord(record) {
  if (!record) return;
  const rows = [
    ['Subject', record.subject],
    ['Matched name', record.matched_name],
    ['Registry', record.source_name],
    ['Status', `${record.status}${record.status_detail ? ` (${record.status_detail})` : ''}`],
    ['Licence / record', record.licence_number || 'not applicable'],
    ['Expiry', record.expiry_date || 'not applicable'],
    ['Disciplinary', (record.disciplinary_actions || []).join('; ')],
    ['Source', record.source_url],
    ['Checked at', record.checked_at],
  ];
  for (const [label, value] of rows) console.log(`${label.padEnd(16)} ${value ?? ''}`);
  const extra = Object.entries(record.fields || {});
  if (extra.length) {
    console.log('Fields');
    for (const [key, value] of extra) {
      console.log(`  ${key.padEnd(30)} ${Array.isArray(value) ? value.join('; ') : value}`);
    }
  }
  if (record.notes?.length) {
    console.log('Notes');
    for (const note of record.notes) console.log(`  - ${note}`);
  }
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'registries') {
    const matrix = coverageMatrix();
    for (const registry of listRegistryMetadata()) {
      console.log(`${registry.name} [${registry.id}]`);
      console.log(`  types: ${registry.types.join(', ')} | jurisdictions: ${registry.jurisdictions.join(', ')} | via ${registry.kind}`);
      console.log(`  ${registry.source_url}`);
      console.log(`  ${registry.description}`);
    }
    console.log('\nSupported combinations:');
    for (const combo of matrix.combinations) console.log(`  ${combo.licence_type} / ${combo.jurisdiction} -> ${combo.registries.join(', ')}`);
    return;
  }

  if (command === 'verify') {
    const subject = argv[1];
    if (!subject) throw new Error('Provide a name: node cli.js verify "Tesco PLC" --type business --jurisdiction UK');
    const result = await verify({
      subject,
      licence_type: flag('type', 'business'),
      jurisdiction: flag('jurisdiction', 'UK'),
      number: flag('number'),
      refresh: has('refresh'),
    }, { refresh: has('refresh') });

    if (has('json')) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`\nMatch quality: ${result.match_quality} (${result.duration_ms} ms)`);
    if (result.primary) printRecord(result.primary);
    if (result.candidates?.length) {
      console.log('\nCandidates (nothing auto-selected):');
      for (const candidate of result.candidates) {
        console.log(`  ${candidate.name} | ${candidate.licence_number || '-'} | ${candidate.status} | ${candidate.source_url}`);
      }
    }
    if (result.near_misses?.length) {
      console.log('\nNear misses (below the match threshold, not results):');
      for (const candidate of result.near_misses) {
        console.log(`  ${candidate.name} | ${candidate.licence_number || '-'} | ${candidate.source_url}`);
      }
    }
    for (const note of result.notes || []) console.log(`\nNote: ${note}`);
    return;
  }

  if (command === 'monitors') {
    const monitors = await listWatches();
    if (!monitors.length) {
      console.log('No watched records yet.');
      return;
    }
    for (const monitor of monitors) {
      console.log(`${monitor.id}  ${monitor.subject}  [${monitor.licence_type}/${monitor.jurisdiction}]  ${monitor.snapshot?.status}  ${monitor.source_url}`);
    }
    return;
  }

  if (command === 'monitor') {
    const id = argv[1];
    if (!id) throw new Error('Provide a monitor id.');
    const { monitor, events } = await getWatch(id);
    console.log(JSON.stringify(monitor, null, 2));
    console.log(`\nEvents: ${events.length}`);
    for (const event of events) console.log(`  ${event.checked_at} ${event.summary}`);
    return;
  }

  if (command === 'watch') {
    const subject = argv[1];
    if (!subject) throw new Error('Provide a name to watch.');
    const { monitor, record } = await createWatch({
      subject,
      licence_type: flag('type', 'business'),
      jurisdiction: flag('jurisdiction', 'UK'),
      number: flag('number'),
    });
    console.log(`Watching ${monitor.id} — ${monitor.subject} on ${monitor.registry_name}`);
    console.log(`Schedule: ${monitor.schedule_cron} | TinyFish monitor: ${monitor.tinyfish_monitor_id || 'not created'}`);
    printRecord(record);
    return;
  }

  if (command === 'check') {
    const id = argv[1];
    if (!id) throw new Error('Provide a monitor id.');
    const result = await checkWatch(id);
    console.log(result.note);
    if (result.event) console.log(JSON.stringify(result.event, null, 2));
    return;
  }

  if (command === 'unwatch') {
    const id = argv[1];
    if (!id) throw new Error('Provide a monitor id.');
    const result = await deleteWatch(id);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (process.env.TINYVERIFY_DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
