// The Sunlight look (see styles.css), remembered on this device.
import { useEffect, useState } from 'react';

const KEY = 'brt:sunlight';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Puts the saved look on the page before the first paint */
export function applySavedSunlight() {
  if (read()) document.documentElement.dataset.theme = 'sun';
}

export function useSunlight(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (on) document.documentElement.dataset.theme = 'sun';
    else delete document.documentElement.dataset.theme;
    try {
      if (on) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {}
  }, [on]);
  return [on, setOn];
}
