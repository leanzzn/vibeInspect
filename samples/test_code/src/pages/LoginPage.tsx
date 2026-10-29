import { useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import DemoNotice from '../components/DemoNotice';
import { sampleStudent } from '../data/sampleStudent';
import { useStudent } from '../state/StudentContext';

export default function LoginPage() {
  const { saveStudent } = useStudent();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  const start = () => {
    saveStudent(sampleStudent);
    navigate('/setup');
  };

  // 확장자만 확인한다. 파일 내용은 읽지도, 저장하지도, 전송하지도 않는다.
  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError(`PDF 파일만 업로드할 수 있습니다. (선택한 파일: ${file.name})`);
      e.target.value = '';
      return;
    }
    setError('');
    start();
  };

  return (
    <div className="page">
      <DemoNotice />
      <section className="card">
        <h1>졸업요건 진단 · 장학금 추천</h1>
        <p>성적표를 바탕으로 졸업요건 충족 여부를 진단하고, 조건에 맞는 장학금을 보여주는 데모 서비스입니다.</p>
      </section>

      <section className="card">
        <h2>성적표 PDF 업로드</h2>
        <p className="notice">
          PDF 내용은 실제로 분석하지 않습니다. 올바른 PDF를 선택하면 샘플 학생 데이터가 대신 로드되며, 파일은 저장·전송되지 않습니다.
        </p>
        <input type="file" accept=".pdf,application/pdf" onChange={handleFile} />
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <button className="primary" onClick={start}>샘플 데이터로 시작하기</button>
      </section>
    </div>
  );
}
