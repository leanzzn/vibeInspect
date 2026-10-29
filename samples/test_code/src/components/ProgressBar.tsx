export default function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="progress" aria-label={`${pct}%`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
