// 이 파일 안에서만 쓰는 format: lib/format.ts의 format과 다른 함수다.
function format(n: number) {
  return n.toFixed(2);
}

export function totalPrice(items: { price: number }[], qty: number) {
  return Number(format(items.reduce((s, i) => s + i.price, 0) * qty));
}
