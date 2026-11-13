import { analysisSettings, positionSeed, runPlayout, sampleSeed, summarizeEstimate, type AnalysisCommand, type AnalysisResponse } from './win-probability';

// No DOM, networking, model API or access to subsequent replay frames in a playout.
let generation = 0;
let activeId: string | null = null;
const send = (message: AnalysisResponse) => postMessage(message);
const yieldToMessages = () => new Promise<void>(resolve => setTimeout(resolve, 0));

self.onmessage = async (event: MessageEvent<AnalysisCommand>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (message.id === activeId) { generation++; activeId = null; }
    return;
  }
  const job = ++generation;
  activeId = message.id;
  const settings = analysisSettings(message.options);
  try {
    for (let index = 0; index < message.states.length; index++) {
      if (job !== generation) return;
      const state = message.states[index];
      const wins: [number, number] = [0, 0]; let unfinished = 0;
      if (state.phase !== 'gameOver') {
        const seed = positionSeed(state, settings.seed);
        for (let sample = 0; sample < settings.samples; sample++) {
          const result = runPlayout(state, sampleSeed(seed, sample), settings.maxActions);
          if (result.winner === null) unfinished++; else wins[result.winner]++;
          await yieldToMessages();
          if (job !== generation) return;
        }
      }
      send({ type: 'point', id: message.id, index, estimate: summarizeEstimate(state, wins, unfinished, state.phase === 'gameOver' ? 0 : settings.samples) });
      await yieldToMessages();
    }
    if (job === generation) { activeId = null; send({ type: 'done', id: message.id }); }
  } catch (error) {
    if (job === generation) { activeId = null; send({ type: 'error', id: message.id, message: error instanceof Error ? error.message : '本地模拟失败' }); }
  }
};
