import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Join, type Joined } from './screens/Join.tsx';
import { RegattaScreen } from './screens/RegattaScreen.tsx';
import { safeStorage } from './lib/useRegatta.ts';
import { applySavedSunlight } from './lib/sunlight.ts';

applySavedSunlight();

const LAST = 'brt:last-joined';

/** A link can carry the regatta: ?r=CODE&pin=1234; otherwise the last one joined on this device */
function initialJoin(): Joined | undefined {
  const q = new URLSearchParams(window.location.search);
  const r = q.get('r');
  if (r) return { regattaId: r.toUpperCase(), ...(q.get('pin') ? { pin: q.get('pin')! } : {}) };
  try {
    const raw = safeStorage()?.getItem(LAST);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function App() {
  const [joined, setJoined] = useState<Joined | undefined>(initialJoin);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    // The PIN doesn't stay in the address bar (or in a shared screenshot of it)
    if (window.location.search) history.replaceState(null, '', window.location.pathname);
    try {
      if (joined) safeStorage()?.setItem(LAST, JSON.stringify(joined));
      else safeStorage()?.removeItem(LAST);
    } catch {}
  }, [joined]);

  if (!joined) return <Join onJoin={(j) => { setProblem(undefined); setJoined(j); }} problem={problem} />;
  return (
    <RegattaScreen
      key={`${joined.regattaId}|${joined.pin ?? ''}`}
      joined={joined}
      onLeave={(why) => {
        setProblem(why);
        setJoined(undefined);
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
