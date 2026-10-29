export default function DemoNotice({ extra }: { extra?: string }) {
  return (
    <p className="notice">
      ⚠ 실험용 데모이며 모든 데이터와 기준은 임의로 생성되었습니다.{extra && ` ${extra}`}
    </p>
  );
}
