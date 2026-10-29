import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import DemoNotice from '../components/DemoNotice';
import { REGIONS } from '../data/sampleStudent';
import { useRequiredStudent, useStudent } from '../state/StudentContext';
import type { Student } from '../types';

type Form = Record<keyof Student, string>;

// 숫자 필드별 허용 범위
const NUMBER_FIELDS: { key: keyof Student; label: string; min: number; max: number }[] = [
  { key: 'admissionYear', label: '입학 연도', min: 2000, max: 2026 },
  { key: 'semesters', label: '이수 학기', min: 0, max: 16 },
  { key: 'totalCredits', label: '총 이수 학점', min: 0, max: 200 },
  { key: 'majorCredits', label: '전공 이수 학점', min: 0, max: 200 },
  { key: 'generalCredits', label: '교양 이수 학점', min: 0, max: 200 },
  { key: 'currentCredits', label: '이번 학기 수강 중 학점', min: 0, max: 30 },
  { key: 'gpa', label: '평점 (4.5 만점)', min: 0, max: 4.5 },
];

function toForm(s: Student): Form {
  return { ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v === null ? '' : String(v)])) } as Form;
}

function validate(f: Form): string[] {
  const errors: string[] = [];
  if (!f.major.trim()) errors.push('전공을 입력해 주세요.');
  for (const { key, label, min, max } of NUMBER_FIELDS) {
    const n = Number(f[key]);
    if (f[key].trim() === '' || Number.isNaN(n)) errors.push(`${label}을(를) 숫자로 입력해 주세요.`);
    else if (n < min || n > max) errors.push(`${label}은(는) ${min}~${max} 사이여야 합니다.`);
  }
  if (Number(f.majorCredits) + Number(f.generalCredits) > Number(f.totalCredits)) {
    errors.push('전공 + 교양 학점이 총 이수 학점보다 클 수 없습니다.');
  }
  return errors;
}

function toStudent(f: Form): Student {
  return {
    admissionYear: Number(f.admissionYear),
    major: f.major.trim(),
    semesters: Number(f.semesters),
    totalCredits: Number(f.totalCredits),
    majorCredits: Number(f.majorCredits),
    generalCredits: Number(f.generalCredits),
    currentCredits: Number(f.currentCredits),
    gpa: Number(f.gpa),
    region: f.region,
    incomeLevel: f.incomeLevel === '' ? null : Number(f.incomeLevel),
  };
}

export default function SetupPage() {
  const student = useRequiredStudent();
  const { saveStudent } = useStudent();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(() => toForm(student));
  const [errors, setErrors] = useState<string[]>([]);

  const set = (key: keyof Student, value: string) => setForm({ ...form, [key]: value });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validate(form);
    setErrors(errs);
    if (errs.length > 0) return;
    saveStudent(toStudent(form));
    navigate('/result');
  };

  return (
    <div className="page">
      <DemoNotice extra="입력값은 이 탭의 sessionStorage에만 실험용으로 저장됩니다." />
      <form className="card" onSubmit={handleSubmit}>
        <h1>학생 정보 확인</h1>
        <div className="grid">
          <label>
            전공
            <input value={form.major} onChange={(e) => set('major', e.target.value)} />
          </label>
          {NUMBER_FIELDS.map(({ key, label }) => (
            <label key={key}>
              {label}
              <input type="number" step="any" value={form[key]} onChange={(e) => set(key, e.target.value)} />
            </label>
          ))}
          <label>
            거주 지역 (선택)
            <select value={form.region} onChange={(e) => set('region', e.target.value)}>
              <option value="">선택 안 함</option>
              {REGIONS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          <label>
            소득구간 (선택)
            <select value={form.incomeLevel} onChange={(e) => set('incomeLevel', e.target.value)}>
              <option value="">선택 안 함</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}구간</option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">선택 항목을 비워두면 해당 조건이 있는 장학금은 "조건 확인 필요"로 표시됩니다.</p>
        {errors.length > 0 && (
          <ul className="error">
            {errors.map((err) => <li key={err}>{err}</li>)}
          </ul>
        )}
        <button className="primary" type="submit">진단 결과 보기</button>
      </form>
    </div>
  );
}
