// 화면 표시용 형식. pricing.ts에도 같은 이름의 다른 함수가 있다.
export function format(n: number) {
  return `${n.toLocaleString()}원`;
}
