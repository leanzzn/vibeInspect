export function submitOrder(qty: number) {
  return fetch('/api/order', { method: 'POST', body: String(qty) });
}
