const COLORS: Record<string, string> = {
  '충족': 'green', '지원 가능': 'green',
  '미충족': 'red', '지원 불가': 'red',
  '조건 확인 필요': 'yellow',
};

export default function Badge({ label }: { label: string }) {
  return <span className={`badge ${COLORS[label] ?? 'gray'}`}>{label}</span>;
}
