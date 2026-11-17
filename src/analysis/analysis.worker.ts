import { reviewAction } from './action-review';
import { ProgressiveAnalysis, type ProgressiveCommand, type ProgressiveResponse } from './progressive';

// One CPU worker. Yield between real playouts so focus/cancel messages can be handled.
let generation = 0;
let activeId: string | null = null;
let session: ProgressiveAnalysis | null = null;
let running = false;
const send = (message: ProgressiveResponse) => postMessage(message);
const yieldToMessages = (delay = 0) => new Promise<void>(resolve => setTimeout(resolve, delay));

async function pump(job: number, id: string, analysis: ProgressiveAnalysis, initial: boolean, restRatio = 0) {
  running = true;
  try {
    await yieldToMessages();
    if (job !== generation) return;
    if (initial) analysis.estimates.forEach((estimate, index) => { if (estimate) send({ type: 'point', id, index, estimate }); });
    for (;;) {
      if (job !== generation) return;
      const index = analysis.next();
      if (index < 0) { send({ type: 'done', id }); return; }
      const started = performance.now();
      const estimate = analysis.advance(index);
      const elapsed = performance.now() - started;
      await yieldToMessages();
      if (job !== generation) return;
      send({ type: 'point', id, index, estimate });
      if (restRatio) await yieldToMessages(Math.min(30000, Math.max(30, elapsed)) * restRatio);
    }
  } catch (error) {
    if (job === generation) send({ type: 'error', id, message: error instanceof Error ? error.message : '本地模拟失败' });
  } finally { if (job === generation) running = false; }
}

self.onmessage = async (event: MessageEvent<ProgressiveCommand>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (message.id === activeId) { generation++; activeId = null; session = null; running = false; }
    return;
  }
  if (message.type === 'focus') {
    if (message.id !== activeId || !session) return;
    session.prioritize(message.index, message.deep);
    if (!running) await pump(generation, message.id, session, false);
    return;
  }
  if (message.type === 'review') {
    const token = ++generation; activeId = message.id;
    try {
      const review = await reviewAction(message.state, message.action, async () => { await yieldToMessages(); if (token !== generation) throw Error('cancelled'); });
      if (token === generation) { send({ type: 'review', id: message.id, review }); send({ type: 'done', id: message.id }); }
    } catch (error) { if (token === generation) send({ type: 'error', id: message.id, message: String(error) }); }
    return;
  }
  const job = ++generation;
  activeId = message.id;
  session = new ProgressiveAnalysis(message.states, message.resume, message.options, message.method);
  session.prioritize(message.focus ?? -1);
  await pump(job, message.id, session, true, Number.isFinite(message.restRatio) ? Math.max(0, Math.min(2, message.restRatio!)) : 0);
};
