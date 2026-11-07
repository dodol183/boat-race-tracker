// Small building blocks: big touch targets, plain words, signal colours for state.
import { useState, type ReactNode, type ButtonHTMLAttributes } from 'react';

type Tone = 'primary' | 'secondary' | 'danger' | 'quiet';

const TONES: Record<Tone, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110',
  secondary: 'bg-surface text-ink border border-line hover:bg-canvas',
  danger: 'bg-stop text-white hover:brightness-110',
  quiet: 'bg-transparent text-accent hover:underline',
};

export function Button({ tone = 'secondary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-11 px-4 rounded-lg font-semibold inline-flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
    />
  );
}

/** A destructive action asks once more in place, without a pop-up */
export function ConfirmButton({ label, confirm, onConfirm, tone = 'danger', disabled }: { label: string; confirm: string; onConfirm: () => void; tone?: Tone; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button tone={tone === 'danger' ? 'secondary' : tone} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span className="inline-flex flex-wrap gap-2 items-center">
      <Button tone={tone} onClick={() => { setAsking(false); onConfirm(); }}>{confirm}</Button>
      <Button tone="quiet" onClick={() => setAsking(false)}>Cancel</Button>
    </span>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-surface border border-line rounded-xl p-4 space-y-3 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          {title && <h2 className="text-lg font-bold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-sm text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass = 'w-full min-h-11 rounded-lg border border-line bg-canvas px-3 text-base text-ink';

export function Pill({ tone, children }: { tone: 'go' | 'warn' | 'stop' | 'muted'; children: ReactNode }) {
  const c = { go: 'text-go border-go', warn: 'text-warn border-warn', stop: 'text-stop border-stop', muted: 'text-muted border-line' }[tone];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-sm font-semibold ${c}`}>{children}</span>;
}
