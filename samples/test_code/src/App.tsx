import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import Nav from './components/Nav';
import { useStudent } from './state/StudentContext';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import ResultPage from './pages/ResultPage';
import ScholarshipsPage from './pages/ScholarshipsPage';

// 학생 데이터가 없으면 보호된 페이지 대신 로그인으로 보낸다.
function RequireStudent() {
  const { student } = useStudent();
  return student ? <Outlet /> : <Navigate to="/login" replace />;
}

function RootRedirect() {
  const { student } = useStudent();
  return <Navigate to={student ? '/result' : '/login'} replace />;
}

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireStudent />}>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/result" element={<ResultPage />} />
            <Route path="/scholarships" element={<ScholarshipsPage />} />
          </Route>
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </main>
    </>
  );
}
