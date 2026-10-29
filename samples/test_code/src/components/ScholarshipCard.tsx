import type { ScholarshipResult } from '../logic/scholarship';
import Badge from './Badge';

export default function ScholarshipCard({ result }: { result: ScholarshipResult }) {
  const { scholarship: sc, status, reasons } = result;
  return (
    <div className="card">
      <div className="row">
        <h3>{sc.name}</h3>
        <Badge label={status} />
      </div>
      <p>{sc.description}</p>
      <p className="muted">
        금액 {sc.amount.toLocaleString()}원 · 마감 {sc.deadline} · 최소 평점 {sc.minGpa}
        {sc.regions && ` · 지역 ${sc.regions.join('/')}`}
        {sc.maxIncomeLevel !== undefined && ` · 소득 ${sc.maxIncomeLevel}구간 이하`}
      </p>
      <ul className="reasons">
        {reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
    </div>
  );
}
