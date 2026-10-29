import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Student } from '../types';

// 실험용 데이터만 sessionStorage에 저장한다. 탭을 닫으면 사라진다.
const STORAGE_KEY = 'demo-student';

function load(): Student | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Student) : null;
}

interface StudentState {
  student: Student | null;
  saveStudent: (s: Student) => void;
  logout: () => void;
}

const StudentContext = createContext<StudentState | null>(null);

export function StudentProvider({ children }: { children: ReactNode }) {
  const [student, setStudent] = useState<Student | null>(load);

  const saveStudent = (s: Student) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    setStudent(s);
  };

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setStudent(null);
  };

  return <StudentContext.Provider value={{ student, saveStudent, logout }}>{children}</StudentContext.Provider>;
}

export function useStudent() {
  const ctx = useContext(StudentContext);
  if (!ctx) throw new Error('useStudent must be used inside StudentProvider');
  return ctx;
}

// 보호된 페이지 전용: 가드 통과 후이므로 student가 반드시 있다.
export function useRequiredStudent(): Student {
  const { student } = useStudent();
  if (!student) throw new Error('student missing');
  return student;
}
