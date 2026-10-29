import { useState } from 'react';
import DemoNotice from '../components/DemoNotice';
import ScholarshipCard from '../components/ScholarshipCard';
import { scholarships } from '../data/scholarships';
import { recommendScholarships, type SortKey } from '../logic/scholarship';
import { useRequiredStudent } from '../state/StudentContext';
import type { EligibilityStatus } from '../types';

type Filter = '전체' | EligibilityStatus;
const FILTERS: Filter[] = ['전체', '지원 가능', '조건 확인 필요', '지원 불가'];

export default function ScholarshipsPage() {
  const student = useRequiredStudent();
  const [sortKey, setSortKey] = useState<SortKey>('recommend');
  const [filter, setFilter] = useState<Filter>('전체');

  const results = recommendScholarships(scholarships, student, sortKey)
    .filter((r) => filter === '전체' || r.status === filter);

  return (
    <div className="page">
      <DemoNotice extra="장학금은 모두 가상이며 실제 공고·지원 페이지와 연결되지 않습니다." />
      <section className="card">
        <h1>장학금 추천</h1>
        <p className="muted">
          판단 기준: 평점 {student.gpa} · 지역 {student.region || '미입력'} · 소득구간 {student.incomeLevel ?? '미입력'}
        </p>
        <div className="row">
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="recommend">추천순</option>
            <option value="deadline">마감일순</option>
          </select>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {FILTERS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </div>
      </section>

      {results.length === 0 ? (
        <p className="card">조건에 해당하는 장학금이 없습니다. 필터를 바꾸거나 학생 정보를 수정해 보세요.</p>
      ) : (
        results.map((r) => <ScholarshipCard key={r.scholarship.id} result={r} />)
      )}
    </div>
  );
}
