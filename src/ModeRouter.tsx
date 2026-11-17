import { lazy, Suspense, useState } from 'react';
import App from './App';
const OnlineApp = lazy(() => import('./online/OnlineApp'));

export default function ModeRouter() {
  const [online, setOnline] = useState(() => location.hash === '#online');
  const change = (value: boolean) => { history.replaceState(null, '', value ? '#online' : location.pathname + location.search); setOnline(value); };
  return online ? <Suspense fallback={<p>正在打开联机牌桌…</p>}><OnlineApp onLocal={() => change(false)} /></Suspense>
    : <App onOnline={() => change(true)} />;
}
