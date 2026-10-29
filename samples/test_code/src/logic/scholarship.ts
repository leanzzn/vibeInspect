import type { EligibilityStatus, Scholarship, Student } from '../types';

export interface ScholarshipResult {
  scholarship: Scholarship;
  status: EligibilityStatus;
  reasons: string[];
}

export function evaluateScholarship(sc: Scholarship, s: Student): ScholarshipResult {
  const reasons: string[] = [];
  let failed = false;
  let unknown = false;

  if (s.gpa >= sc.minGpa) reasons.push(`평점 ${s.gpa} ≥ 기준 ${sc.minGpa}`);
  else { failed = true; reasons.push(`평점 ${s.gpa} < 기준 ${sc.minGpa}`); }

  if (sc.regions) {
    if (!s.region) { unknown = true; reasons.push(`거주 지역 미입력 (대상: ${sc.regions.join(', ')})`); }
    else if (sc.regions.includes(s.region)) reasons.push(`거주 지역 ${s.region} 대상 포함`);
    else { failed = true; reasons.push(`거주 지역 ${s.region} 대상 아님`); }
  }

  if (sc.maxIncomeLevel !== undefined) {
    if (s.incomeLevel === null) { unknown = true; reasons.push(`소득구간 미입력 (${sc.maxIncomeLevel}구간 이하 대상)`); }
    else if (s.incomeLevel <= sc.maxIncomeLevel) reasons.push(`소득구간 ${s.incomeLevel} ≤ ${sc.maxIncomeLevel}`);
    else { failed = true; reasons.push(`소득구간 ${s.incomeLevel} > ${sc.maxIncomeLevel}`); }
  }

  // 불가 조건이 하나라도 있으면 불가, 아니면 미입력 조건이 있을 때 확인 필요
  const status: EligibilityStatus = failed ? '지원 불가' : unknown ? '조건 확인 필요' : '지원 가능';
  return { scholarship: sc, status, reasons };
}

export type SortKey = 'recommend' | 'deadline';

const STATUS_RANK: Record<EligibilityStatus, number> = { '지원 가능': 0, '조건 확인 필요': 1, '지원 불가': 2 };

export function sortResults(results: ScholarshipResult[], key: SortKey): ScholarshipResult[] {
  return [...results].sort((a, b) =>
    key === 'deadline'
      ? a.scholarship.deadline.localeCompare(b.scholarship.deadline)
      : STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.scholarship.amount - a.scholarship.amount,
  );
}

export function recommendScholarships(list: Scholarship[], s: Student, key: SortKey = 'recommend') {
  return sortResults(list.map((sc) => evaluateScholarship(sc, s)), key);
}
