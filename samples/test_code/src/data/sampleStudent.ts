import type { Student } from '../types';

// 가상 학생. PDF를 선택해도 내용 대신 이 값이 로드된다.
export const sampleStudent: Student = {
  admissionYear: 2022,
  major: '컴퓨터공학',
  semesters: 6,
  totalCredits: 102,
  majorCredits: 48,
  generalCredits: 27,
  currentCredits: 18,
  gpa: 3.6,
  region: '',
  incomeLevel: null,
};

export const REGIONS = ['서울', '경기', '강원', '충청', '전라', '경상', '제주'];
