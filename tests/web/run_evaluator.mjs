// Parity runner: reads an architecture JSON from stdin, evaluates it with
// the JS evaluator, and writes a deterministic JSON result to stdout.
//
// tests/test_parity.py spawns this from the Python side and compares the
// result against the Python evaluator's output on the same input.

import { evaluateArchitecture } from '../../web/evaluator.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

const text = await readStdin();
const arch = JSON.parse(text);
const report = evaluateArchitecture(arch);

const payload = {
  domain: report.domain,
  source_standards: report.source_standards,
  distribution: report.distribution(),
  conduits: report.results.map((r) => ({
    conduit_id: r.conduit_id,
    sc1: r.sc1,
    nc1: r.nc1,
    nc2: r.nc2,
    verdict: r.verdict,
    mitigation: r.mitigation,
    rationale: r.rationale,
  })),
};

process.stdout.write(JSON.stringify(payload));
