import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { QuickLaunch } from './quick/QuickLaunch';

// The quick-launch window loads the same bundle as `index.html#quick`.
const quick = window.location.hash === '#quick';
if (quick) document.documentElement.classList.add('fd-quick-window');

createRoot(document.getElementById('root')!).render(<StrictMode>{quick ? <QuickLaunch /> : <App />}</StrictMode>);
