import { NavLink, useNavigate } from 'react-router-dom';
import { useStudent } from '../state/StudentContext';

export default function Nav() {
  const { student, logout } = useStudent();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="nav">
      <strong>졸업요건 진단 데모</strong>
      {student && (
        <nav>
          <NavLink to="/result">진단 결과</NavLink>
          <NavLink to="/scholarships">장학금 추천</NavLink>
          <NavLink to="/setup">정보 수정</NavLink>
          <button onClick={handleLogout}>로그아웃</button>
        </nav>
      )}
    </header>
  );
}
