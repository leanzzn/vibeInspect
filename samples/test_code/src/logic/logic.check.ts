// 실행: npm run check
import assert from 'node:assert';
import { diagnoseGraduation } from './graduation.ts';
import { evaluateScholarship, recommendScholarships } from './scholarship.ts';
import { sampleStudent } from '../data/sampleStudent.ts';
import { scholarships } from '../data/scholarships.ts';

const d = diagnoseGraduation(sampleStudent);
assert.equal(d.current[0].remaining, 28);
assert.equal(d.expectedTotal.earned, 120);
assert.equal(d.todo.length, 3);
assert.ok(diagnoseGraduation({ ...sampleStudent, totalCredits: 130, majorCredits: 60, generalCredits: 30 }).allMet);

const regional = scholarships.find((s) => s.id === 's3')!;
assert.equal(evaluateScholarship(regional, sampleStudent).status, '조건 확인 필요');
assert.equal(evaluateScholarship(regional, { ...sampleStudent, region: '강원' }).status, '지원 가능');
assert.equal(evaluateScholarship(regional, { ...sampleStudent, region: '서울' }).status, '지원 불가');
assert.equal(evaluateScholarship(regional, { ...sampleStudent, gpa: 2.0 }).status, '지원 불가');

const byDeadline = recommendScholarships(scholarships, sampleStudent, 'deadline');
assert.equal(byDeadline[0].scholarship.id, 's4');
console.log('logic checks passed');
