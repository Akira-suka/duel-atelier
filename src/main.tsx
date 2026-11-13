import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { theme, DECKS } from './theme';

document.title = theme.title;
document.documentElement.dataset.theme = theme.id;
document.documentElement.style.setProperty('--table-art', `url("${theme.table}")`);
document.documentElement.style.setProperty('--reserve-art', `url("${DECKS[2].image}")`);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
