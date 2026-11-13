import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; const value = process.argv[i + 1];
  if (!key.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Expected --option value, got ${key}`);
  flags.set(key.slice(2), value);
}
const allowed = ['mode', 'section', 'output', 'pairs', 'positions', 'samples', 'iterations', 'prediction-iterations', 'max-actions', 'repeats', 'prefix'];
for (const key of flags.keys()) if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
const mode = flags.get('mode') ?? 'smoke';
if (!['smoke', 'full'].includes(mode)) throw new Error('Mode must be smoke or full');
const section = flags.get('section') ?? 'all';
if (!['all', 'tactics', 'arena', 'prediction'].includes(section)) throw new Error('Section must be all, tactics, arena or prediction');
const integer = (name, fallback, maximum = 10000) => {
  const value = Number(flags.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid --${name}`);
  return value;
};
const config = {
  mode, section,
  pairs: integer('pairs', mode === 'smoke' ? 2 : 12, 1000),
  positions: integer('positions', mode === 'smoke' ? 4 : 16, 1000),
  samples: integer('samples', mode === 'smoke' ? 4 : 24, 128),
  iterations: integer('iterations', mode === 'smoke' ? 8 : 32, 4096),
  predictionIterations: integer('prediction-iterations', mode === 'smoke' ? 4 : 8, 4096),
  maxActions: integer('max-actions', 600, 2000),
  repeats: integer('repeats', mode === 'smoke' ? 2 : 3, 100),
  prefix: flags.get('prefix') ?? 'duel-eval-v1',
};
const sources = ['src/analysis/win-probability.ts', 'src/analysis/search-policy.ts', 'src/analysis/search.ts', 'src/analysis/tactics.ts', 'src/analysis/evaluation.ts'];
const hashes = {};
for (const source of sources) {
  const data = await readFile(resolve(root, source));
  hashes[source] = createHash('sha256').update(data).digest('hex');
}
const bundled = await build({ stdin: {
  contents: `import * as evaluation from './src/analysis/evaluation.ts';\nimport * as baseline from './src/analysis/win-probability.ts';\nimport * as candidate from './src/analysis/search-policy.ts';\nexport { evaluation, baseline, candidate };`,
  resolveDir: root, sourcefile: 'ai-benchmark-entry.ts', loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { evaluation: ev, baseline, candidate } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
if (typeof candidate.chooseSearchAction !== 'function' || typeof candidate.estimateSearchWinProbability !== 'function') {
  throw new Error('Candidate must export chooseSearchAction and estimateSearchWinProbability');
}
const baselinePolicy = (state, context) => baseline.chooseSimulationAction(state, context.random);
const candidatePolicy = (state, context) => candidate.chooseSearchAction(state, context.random, { iterations: config.iterations, seed: context.seed });
const started = performance.now();
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), config, sources: hashes,
  environment: { node: process.version, platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)) },
  interpretation: [
    'Fixed budgets and deterministic seeds; no wall-clock search cutoff.',
    'Arena legs share a seed and exchange algorithm seats; confidence bounds group both legs by seed.',
    'Unfinished games are never treated as losses or draws.',
    'Prediction outcomes come from separate economy/points/crowns reference players, not either evaluated policy.',
    'Reference-policy outcomes measure cross-policy generalization, not human calibration or optimal-play truth.',
    'One nonterminal position at preselected ply 35 per held-out game; no adjacent-position train/test split.',
    'Small smoke/full samples are diagnostics; favorable point estimates alone do not establish superiority.',
  ],
};
console.error(`AI benchmark ${JSON.stringify(config)}`);
if (section === 'all' || section === 'tactics') {
  report.tactics = { baseline: ev.runTacticalBenchmarks(baselinePolicy), candidate: ev.runTacticalBenchmarks(candidatePolicy) };
  console.error(`Tactics: baseline ${report.tactics.baseline.filter(row => row.passed).length}/${report.tactics.baseline.length}; candidate ${report.tactics.candidate.filter(row => row.passed).length}/${report.tactics.candidate.length}`);
}
if (section === 'all' || section === 'arena') {
  const seeds = Array.from({ length: config.pairs }, (_, i) => `${config.prefix}:arena:${i + 1}`);
  report.arena = ev.runPairedArena(seeds, candidatePolicy, baselinePolicy, { maxActions: config.maxActions,
    onGame: game => console.error(`Arena ${game.pairId} seat ${game.candidateSeat}: ${game.winner ?? 'unfinished'}, ${game.actions} actions, ${Math.round(game.milliseconds)}ms`) });
}
if (section === 'all' || section === 'prediction') {
  const seeds = Array.from({ length: config.positions }, (_, i) => `${config.prefix}:holdout:${i + 1}`);
  ev.assertDisjointGameIds(Array.from({ length: config.pairs }, (_, i) => `${config.prefix}:arena:${i + 1}`), seeds);
  const corpus = ev.generateHeldoutCorpus(seeds, 35, { maxActions: config.maxActions });
  const rows = [];
  for (const [index, point] of corpus.positions.entries()) {
    const seed = ev.evaluationSeed(`prediction:${point.gameId}`);
    let begin = performance.now();
    const oldEstimate = baseline.estimateWinProbability(point.state, { samples: config.samples, maxActions: config.maxActions, seed });
    const oldMs = performance.now() - begin;
    begin = performance.now();
    const newEstimate = candidate.estimateSearchWinProbability(point.state, { samples: config.samples, maxActions: config.maxActions, seed, searchIterations: config.predictionIterations });
    const newMs = performance.now() - begin;
    rows.push({ gameId: point.gameId, ply: point.ply, outcome: point.outcome, baseline: oldEstimate, candidate: newEstimate,
      baselineMilliseconds: oldMs, candidateMilliseconds: newMs });
    console.error(`Prediction ${index + 1}/${corpus.positions.length}: old=${oldEstimate.probability}, new=${newEstimate.probability}, actual=${point.outcome}, ${Math.round(oldMs)}/${Math.round(newMs)}ms`);
  }
  const metrics = (subset, side) => ev.predictionMetrics(subset.map(row => ({ gameId: row.gameId, probability: row[side].probability, outcome: row.outcome })));
  const common = rows.filter(row => row.baseline.probability !== null && row.candidate.probability !== null);
  report.prediction = { requestedGames: seeds.length, excluded: corpus.excluded, rows,
    allAvailable: { baseline: metrics(rows, 'baseline'), candidate: metrics(rows, 'candidate') },
    commonCoverage: { games: common.length, baseline: metrics(common, 'baseline'), candidate: metrics(common, 'candidate') } };
  if (corpus.positions.length) {
    const point = corpus.positions[0]; const oldValues = [], newValues = [];
    for (let repeat = 0; repeat < config.repeats; repeat++) {
      const seed = ev.evaluationSeed(`repeat:${point.gameId}:${repeat}`);
      const oldValue = baseline.estimateWinProbability(point.state, { samples: config.samples, maxActions: config.maxActions, seed }).probability;
      const newValue = candidate.estimateSearchWinProbability(point.state, { samples: config.samples, maxActions: config.maxActions, seed, searchIterations: config.predictionIterations }).probability;
      if (oldValue !== null) oldValues.push(oldValue);
      if (newValue !== null) newValues.push(newValue);
    }
    report.samplingDispersion = { gameId: point.gameId, repeats: config.repeats, baseline: ev.samplingDispersion(oldValues), candidate: ev.samplingDispersion(newValues) };
  }
}
report.elapsedMilliseconds = performance.now() - started;
const text = `${JSON.stringify(report, null, 2)}\n`;
if (flags.has('output')) {
  const destination = resolve(flags.get('output'));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text, 'utf8');
  console.error(`Saved ${destination}; ${Math.round(report.elapsedMilliseconds)}ms`);
} else process.stdout.write(text);
