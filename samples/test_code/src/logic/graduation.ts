import type { Student } from '../types';

// 임의로 정한 데모용 졸업 기준
export const GRAD_RULES = { total: 130, major: 60, general: 30 };

export interface RequirementResult {
  label: string;
  required: number;
  earned: number; // 현재 이수
  remaining: number;
  met: boolean;
}

function check(label: string, required: number, earned: number): RequirementResult {
  const remaining = Math.max(0, required - earned);
  return { label, required, earned, remaining, met: remaining === 0 };
}

export function diagnoseGraduation(s: Student) {
  const current = [
    check('총 학점', GRAD_RULES.total, s.totalCredits),
    check('전공 학점', GRAD_RULES.major, s.majorCredits),
    check('교양 학점', GRAD_RULES.general, s.generalCredits),
  ];
  // 수강 중 학점은 총 학점에만 더한다 (전공/교양 구분 정보가 없으므로)
  const expectedTotal = check('총 학점 (수강 중 포함 예상)', GRAD_RULES.total, s.totalCredits + s.currentCredits);
  const todo = current.filter((r) => !r.met);
  return { current, expectedTotal, todo, allMet: todo.length === 0 };
}
