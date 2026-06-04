/**
 * Emit corrected Flux queries for Module 5 peer-band panel (id 424).
 * Usage: npx tsx scripts/emit-fixed-panel-424.ts [path-to-panel-json]
 */
import { readFileSync, writeFileSync } from 'fs';
import { applyModule5PeerBandFluxFixes } from '../src/services/fluxPeerBandFix';

const inputPath =
    process.argv[2] ??
    new URL('./fixtures/panel-424-broken-input.json', import.meta.url).pathname;

const panel = JSON.parse(readFileSync(inputPath, 'utf8')) as Record<string, unknown>;
const { panel: fixed, changed } = applyModule5PeerBandFluxFixes(panel, { force: true });

const outPath = inputPath.replace(/\.json$/, '-fixed.json');
writeFileSync(outPath, JSON.stringify(fixed, null, 2));

console.log('changed:', changed);
console.log('wrote:', outPath);
for (const t of (fixed.targets as { refId: string; query: string }[]) ?? []) {
    console.log('\n---', t.refId, '---\n');
    console.log(t.query);
}
