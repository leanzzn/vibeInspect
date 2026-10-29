import type { Scholarship } from '../types';

// 모두 가상의 장학금이다. 실제 공고와 무관.
export const scholarships: Scholarship[] = [
  { id: 's1', name: '[가상] 성적우수 장학금', amount: 2000000, deadline: '2026-12-15', description: '평점 기준만 보는 데모 장학금', minGpa: 3.8 },
  { id: 's2', name: '[가상] 희망나눔 장학금', amount: 1500000, deadline: '2026-11-20', description: '소득구간 기준 데모 장학금', minGpa: 2.5, maxIncomeLevel: 4 },
  { id: 's3', name: '[가상] 지역인재 장학금', amount: 1000000, deadline: '2026-12-01', description: '지방 거주 학생 대상 데모 장학금', minGpa: 3.0, regions: ['강원', '충청', '전라', '경상', '제주'] },
  { id: 's4', name: '[가상] 수도권 통학 지원금', amount: 500000, deadline: '2026-11-10', description: '수도권 거주 학생 대상 데모 지원금', minGpa: 2.0, regions: ['서울', '경기'] },
  { id: 's5', name: '[가상] 꿈사다리 장학금', amount: 3000000, deadline: '2027-01-05', description: '평점·소득 복합 조건 데모 장학금', minGpa: 3.5, maxIncomeLevel: 3 },
  { id: 's6', name: '[가상] 도전 장학금', amount: 700000, deadline: '2026-11-30', description: '누구나 지원 가능한 데모 장학금', minGpa: 0 },
  { id: 's7', name: '[가상] 지역상생 장학금', amount: 1200000, deadline: '2026-12-20', description: '지역·소득 복합 조건 데모 장학금', minGpa: 3.2, regions: ['경기', '강원'], maxIncomeLevel: 6 },
];
