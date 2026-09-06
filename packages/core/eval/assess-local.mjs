#!/usr/bin/env node
// Development smoke set, NOT a holdout or model qualification. No source writes.
// node packages/core/eval/assess-local.mjs qwen2.5:7b /tmp/assessment-report.json
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLocalContextAssessor } from '../../../apps/desktop/src/main/context-assessor.mjs';
import { ASSESSMENT_SCHEMA, validateAssessment } from '../src/discrepancy-assessment.mjs';
const [model, output] = process.argv.slice(2);
if (!model || !output) throw new Error('Provide an installed local model and an output report path.');
const provider = createLocalContextAssessor();
const installed = (await provider.models()).models.find(row => row.name === model);
if (!installed) throw new Error('That local model is not installed.');
const cases = JSON.parse(await fsp.readFile(fileURLToPath(new URL('./assessment-cases.json', import.meta.url)), 'utf8'));
const rows = [];
for (const item of cases) {
  const packet = { version: 1, profileId: 'assessment-development', discrepancyId: item.id,
    contributions: [{ source: 'personal', content: item.a, updated: null, level: 3 }, { source: 'team', content: item.b, updated: null, level: 2 }] };
  const start = Date.now();
  try {
    const result = await provider.assess({ packet, schema: ASSESSMENT_SCHEMA, model, digest: installed.digest });
    const assessment = validateAssessment(result.value, packet);
    rows.push({ id: item.id, family: item.family, durationMs: Date.now() - start, assessment,
      expected: { categories: item.categories, selectedSource: item.selectedSource },
      correct: item.categories.includes(assessment.category) && assessment.selectedSource === item.selectedSource });
  } catch (error) { rows.push({ id: item.id, durationMs: Date.now() - start, correct: false, error: error.message }); }
  console.log(`${item.id}: ${rows.at(-1).correct ? 'pass' : 'FAIL'} (${rows.at(-1).durationMs}ms)`);
}
const report = { generatedAt: new Date().toISOString(), model, digest: installed.digest,
  purpose: 'Synthetic development smoke only. Not a held-out benchmark; no model is qualified for autonomous semantic selection.',
  cases: rows.length, passed: rows.filter(row => row.correct).length,
  validatedResponses: rows.filter(row => row.assessment).length,
  sourceWrites: 0, automaticallyApplied: 0, rows };
await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${output}`);
process.exitCode = report.passed === report.cases ? 0 : 1;
