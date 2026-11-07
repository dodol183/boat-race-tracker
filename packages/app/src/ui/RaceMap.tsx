// The course and the boats on a map. Leaflet with OpenStreetMap tiles; marks and boats are drawn
// by the app, so they show even when the tiles can't load (at sea, without signal).
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { finishLine, isFixLive, type Course, type Fix, type LatLng, type RegattaState } from '@brt/engine';

/** Class colours: distinct on the map in daylight, and not the start/finish line colours */
const CLASS_COLOURS = ['#1d4ed8', '#c2410c', '#15803d', '#7e22ce', '#be185d', '#0e7490', '#a16207'];
/** A fix older than this shows faded: the boat is probably no longer there */
const STALE_MS = 2 * 60_000;
/** How much of each boat's track is drawn */
const TRAIL_MS = 10 * 60_000;

export const MARK_LABELS: Record<keyof Course, string> = {
  startPin: 'Start pin',
  startCommittee: 'Committee boat',
  firstMark: 'First mark',
  finishPin: 'Finish pin',
  finishCommittee: 'Finish boat',
};

export function RaceMap({
  regatta,
  tracks,
  now,
  course,
  onPick,
  className = 'h-80',
}: {
  regatta: RegattaState;
  tracks: Record<string, Fix[]>;
  now: number;
  /** A course to show instead of the regatta's (the one being edited) */
  course?: Course;
  /** Tapping the map gives a position (placing a mark) */
  onPick?: (p: LatLng) => void;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const courseLayer = useRef<L.LayerGroup | null>(null);
  const boatLayer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const markCount = useRef(0);
  const shown = course ?? regatta.course ?? {};

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true }).setView([0, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    courseLayer.current = L.layerGroup().addTo(m);
    boatLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    // Placing marks with nothing on the map yet: start where this phone is
    if (onPick) {
      m.once('locationfound', (e: L.LocationEvent) => {
        if (!fitted.current) m.setView(e.latlng, 15);
      });
      m.locate({ setView: false, enableHighAccuracy: true });
    }
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !onPick) return;
    const click = (e: L.LeafletMouseEvent) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    m.on('click', click);
    el.current?.classList.add('cursor-crosshair');
    return () => {
      m.off('click', click);
      el.current?.classList.remove('cursor-crosshair');
    };
  }, [onPick]);

  // The course
  useEffect(() => {
    const layer = courseLayer.current;
    if (!layer) return;
    layer.clearLayers();
    const state = { ...regatta, course: shown };
    if (shown.startPin && shown.startCommittee) {
      L.polyline([toL(shown.startPin), toL(shown.startCommittee)], { color: '#16a34a', weight: 4 }).bindTooltip('Start line').addTo(layer);
    }
    const fin = finishLine(state);
    if (fin && shown.finishPin) L.polyline([toL(fin[0]), toL(fin[1])], { color: '#dc2626', weight: 4, dashArray: '8 6' }).bindTooltip('Finish line').addTo(layer);
    for (const k of Object.keys(MARK_LABELS) as (keyof Course)[]) {
      const p = shown[k];
      if (!p) continue;
      L.circleMarker(toL(p), { radius: 7, color: '#111827', weight: 2, fillColor: k === 'firstMark' ? '#facc15' : '#f97316', fillOpacity: 1 })
        .bindTooltip(MARK_LABELS[k], { direction: 'top' })
        .addTo(layer);
    }
    // While marks are being placed, keep them all in view
    const count = Object.values(shown).filter(Boolean).length;
    if (onPick && count > markCount.current) fitted.current = false;
    markCount.current = count;
    fitOnce();
  }, [shown, regatta.boats]);

  // The boats, redrawn as positions come in
  useEffect(() => {
    const layer = boatLayer.current;
    if (!layer) return;
    layer.clearLayers();
    const classIds = Object.keys(regatta.classes).sort();
    for (const b of Object.values(regatta.boats)) {
      const trail = b.trackerId ? tracks[b.trackerId] : undefined;
      const last = trail?.at(-1);
      if (!last || !isFixLive(last, now)) continue;
      const stale = now - last.fixTime > STALE_MS;
      const colour = CLASS_COLOURS[Math.max(0, classIds.indexOf(b.classId)) % CLASS_COLOURS.length]!;
      const recent = trail!.filter((f) => f.fixTime >= now - TRAIL_MS).map(toL);
      if (recent.length > 1) L.polyline(recent, { color: colour, weight: 2, opacity: stale ? 0.3 : 0.7 }).addTo(layer);
      L.circleMarker(toL(last), { radius: 6, color: '#ffffff', weight: 2, fillColor: colour, fillOpacity: stale ? 0.4 : 1 }).addTo(layer);
      const ago = Math.round((now - last.fixTime) / 1000);
      L.marker(toL(last), {
        icon: L.divIcon({ className: 'boat-label', html: `<span style="opacity:${stale ? 0.55 : 1}">${escapeHtml(b.sailNumber)}</span>`, iconSize: undefined, iconAnchor: [-8, 10] }),
        keyboard: false,
        interactive: true,
        title: `${b.sailNumber}${b.name ? ` ${b.name}` : ''}: ${last.speedKt !== undefined ? `${last.speedKt.toFixed(1)} kn, ` : ''}${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago`,
      }).addTo(layer);
    }
    fitOnce();
  }, [regatta.boats, regatta.classes, tracks, Math.floor(now / 5000)]);

  /** Frames the course and boats the first time there is something to show */
  function fitOnce() {
    const m = map.current;
    if (!m || fitted.current) return;
    const pts: L.LatLngExpression[] = [];
    for (const p of Object.values(shown)) if (p) pts.push(toL(p));
    for (const b of Object.values(regatta.boats)) {
      const last = b.trackerId ? tracks[b.trackerId]?.at(-1) : undefined;
      if (last && isFixLive(last, now)) pts.push(toL(last));
    }
    if (pts.length === 0) return;
    fitted.current = true;
    if (pts.length === 1) m.setView(pts[0]!, 15);
    else m.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
  }

  return (
    <div className="relative">
      <div ref={el} className={`w-full rounded-lg border border-line z-0 ${className}`} role="region" aria-label="Map of the course and boats" />
      <button
        type="button"
        onClick={() => {
          fitted.current = false;
          fitOnce();
        }}
        className="absolute top-2 right-2 z-[400] min-h-11 px-3 rounded-lg bg-surface border border-line font-semibold shadow"
      >
        Fit
      </button>
    </div>
  );
}

const toL = (p: LatLng): L.LatLngTuple => [p.lat, p.lng];
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
