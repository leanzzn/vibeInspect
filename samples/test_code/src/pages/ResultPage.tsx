import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import DemoNotice from '../components/DemoNotice';
import ProgressBar from '../components/ProgressBar';
import ScholarshipCard from '../components/ScholarshipCard';
import { scholarships } from '../data/scholarships';
import { diagnoseGraduation, type RequirementResult } from '../logic/graduation';
import { recommendScholarships } from '../logic/scholarship';
import { useRequiredStudent } from '../state/StudentContext';

function RequirementRow({ r }: { r: RequirementResult }) {
  return (
    <div className="req">
      <div className="row">
        <span>{r.label}: {r.earned} / {r.required}</span>
        <Badge label={r.met ? '충족' : '미충족'} />
      </div>
      <ProgressBar value={r.earned} max={r.required} />
      {!r.met && <small className="muted">남은 학점 {r.remaining}</small>}
    </div>
  );
}

export default function ResultPage() {
  const student = useRequiredStudent();
  const diagnosis = diagnoseGraduation(student);
  const preview = recommendScholarships(scholarships, student).slice(0, 2);

  return (
    <div className="page">
      <DemoNotice extra="졸업 기준은 실제 대학 기준이 아닙니다." />

      <section className="card">
        <h1>학생 정보 요약</h1>
        <p>
          {student.admissionYear}학번 · {student.major} · {student.semesters}학기 이수 · 평점 {student.gpa}
          {' '}· 지역 {student.region || '미입력'} · 소득구간 {student.incomeLevel ?? '미입력'}
        </p>
        <Link to="/setup">학생 정보 수정</Link>
      </section>

      <section className="card">
        <h2>현재 이수 기준</h2>
        {diagnosis.current.map((r) => <RequirementRow key={r.label} r={r} />)}
      </section>

      <section className="card">
        <h2>수강 중 학점 포함 예상</h2>
        <p className="muted">이번 학기 수강 중 {student.currentCredits}학점을 모두 이수한다고 가정한 총 학점입니다.</p>
        <RequirementRow r={diagnosis.expectedTotal} />
      </section>

      <section className="card">
        <h2>보완이 필요한 항목 (현재 이수 기준)</h2>
        {diagnosis.allMet ? (
          <p>현재 이수 기준으로 모든 요건을 충족했습니다.</p>
        ) : (
          <ul>
            {diagnosis.todo.map((r) => <li key={r.label}>{r.label} {r.remaining}학점 추가 이수 필요</li>)}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="row">
          <h2>추천 장학금 미리보기</h2>
          <Link to="/scholarships">전체 보기 →</Link>
        </div>
        {preview.map((r) => <ScholarshipCard key={r.scholarship.id} result={r} />)}
      </section>
    </div>
  );
}
