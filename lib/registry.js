import { abnAu } from './registries/abn-au.js';
import { companiesHouse } from './registries/companies-house.js';
import { cslb } from './registries/cslb.js';
import { mqaFl } from './registries/mqa-fl.js';
import { npi } from './registries/npi.js';
import { tmbFl } from './registries/tmb-fl.js';
import { nzCompanies } from './registries/nz-companies.js';

export const REGISTRIES = [companiesHouse, cslb, npi, tmbFl, nzCompanies, abnAu, mqaFl];

const TYPE_ALIASES = new Map([
  ['business', 'business'], ['company', 'business'], ['companies', 'business'], ['organisation', 'business'],
  ['organization', 'business'], ['corporation', 'business'], ['firm', 'business'], ['employer', 'business'],
  ['contractor', 'contractor'], ['trade', 'contractor'], ['builder', 'contractor'], ['construction', 'contractor'],
  ['health', 'health'], ['healthcare', 'health'], ['provider', 'health'], ['practitioner', 'health'],
  ['npi', 'health'], ['medical', 'health'], ['doctor', 'health'], ['physician', 'health'], ['nurse', 'health'],
]);

const JURISDICTION_ALIASES = new Map([
  ['uk', 'UK'], ['gb', 'UK'], ['gbr', 'UK'], ['united kingdom', 'UK'], ['great britain', 'UK'],
  ['england', 'UK'], ['scotland', 'UK'], ['wales', 'UK'], ['northern ireland', 'UK'], ['ni', 'UK'],
  ['us', 'US'], ['usa', 'US'], ['united states', 'US'], ['united states of america', 'US'],
  ['us-ca', 'US-CA'], ['ca', 'US-CA'], ['california', 'US-CA'], ['calif', 'US-CA'],
  ['us-fl', 'US-FL'], ['fl', 'US-FL'], ['florida', 'US-FL'], ['fla', 'US-FL'],
  ['us-tx', 'US-TX'], ['tx', 'US-TX'], ['texas', 'US-TX'],
  ['nz', 'NZ'], ['new zealand', 'NZ'],
  ['au', 'AU'], ['australia', 'AU'],
  ['ie', 'IE'], ['ireland', 'IE'], ['republic of ireland', 'IE'],
]);

const STATE_ALIASES = new Map([
  ['fl', 'FL'], ['fla', 'FL'], ['florida', 'FL'],
]);

/** Normalise an optional US state filter. Two-letter codes win; full names are mapped. */
export function normalizeState(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return null;
  return STATE_ALIASES.get(key) ?? (key.length === 2 ? key.toUpperCase() : null);
}

export function normalizeType(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return TYPE_ALIASES.get(key) ?? key;
}

export function normalizeJurisdiction(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return JURISDICTION_ALIASES.get(key) ?? String(value ?? '').trim().toUpperCase();
}

const registryTypes = (registry) => registry.meta.types.map(normalizeType);
const registryJurisdictions = (registry) => registry.meta.jurisdictions.map(normalizeJurisdiction);

export function resolveRegistries(type, jurisdiction, { state } = {}) {
  const t = normalizeType(type);
  const j = normalizeJurisdiction(jurisdiction);
  const matches = REGISTRIES.filter((registry) => registryTypes(registry).includes(t) && registryJurisdictions(registry).includes(j));
  if (t !== 'health') return matches;

  // A Florida health query reads the federal NPI registry and the Florida
  // medical board together. health/US stays federal-only unless the caller
  // explicitly asks for Florida with state=FL.
  const ids = new Set(matches.map((registry) => registry.meta.id));
  if (j === 'US-FL' || (j === 'US' && normalizeState(state) === 'FL')) {
    if (!ids.has('npi-us')) {
      const federal = REGISTRIES.find((registry) => registry.meta.id === 'npi-us');
      if (federal) matches.unshift(federal);
      ids.add('npi-us');
    }
    if (!ids.has('mqa-fl')) {
      const florida = REGISTRIES.find((registry) => registry.meta.id === 'mqa-fl');
      if (florida) matches.push(florida);
    }
  }
  return matches;
}

export function registryById(id) {
  return REGISTRIES.find((registry) => registry.meta.id === id) ?? null;
}

export function listRegistryMetadata() {
  return REGISTRIES.map((registry) => ({ ...registry.meta }));
}

/** The coverage matrix shown by /api/registries and used to explain unsupported queries. */
export function coverageMatrix() {
  const types = [...new Set(REGISTRIES.flatMap(registryTypes))];
  const jurisdictions = [...new Set(REGISTRIES.flatMap(registryJurisdictions))];
  const combinations = [];
  for (const type of types) {
    for (const jurisdiction of jurisdictions) {
      const ids = resolveRegistries(type, jurisdiction).map((r) => r.meta.id);
      if (ids.length) combinations.push({ licence_type: type, jurisdiction, registries: ids });
    }
  }
  return { types, jurisdictions, combinations };
}
