export interface Student {
  admissionYear: number;
  major: string;
  semesters: number;
  totalCredits: number;
  majorCredits: number;
  generalCredits: number;
  currentCredits: number; // 이번 학기 수강 중
  gpa: number;
  region: string; // '' = 미입력
  incomeLevel: number | null; // null = 미입력
}

export interface Scholarship {
  id: string;
  name: string;
  amount: number;
  deadline: string; // YYYY-MM-DD
  description: string;
  minGpa: number;
  regions?: string[]; // 없으면 지역 조건 없음
  maxIncomeLevel?: number; // 없으면 소득 조건 없음
}

export type EligibilityStatus = '지원 가능' | '조건 확인 필요' | '지원 불가';
