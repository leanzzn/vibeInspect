import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Shell from './Shell';
import './styles.css';

// 수동 예제와 업로드 자동 분석 결과는 Shell에서 데이터 출처를 나눠 보여 준다.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
