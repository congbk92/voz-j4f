#!/usr/bin/env node
import { analyze } from '../scripts/probe.js';

const snippet = `(() => {
  const analyze = ${analyze.toString()};
  const report = analyze(document);
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === 'function') { copy(json); console.log('\\n✅ JSON copied to clipboard'); }
  else console.log('\\nℹ️ Select the JSON above and copy it manually.');
})();`;

console.log(snippet);
console.error('\n---\nCopy everything above, paste it into the DevTools console on a voz thread page,');
console.error('then paste the JSON it prints back into the conversation.\n');
