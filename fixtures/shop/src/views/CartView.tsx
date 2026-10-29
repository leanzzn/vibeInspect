import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { CATALOG } from '../lib/catalog';
import { format } from '../lib/format';
import { totalPrice } from '../lib/pricing';

const handlers: Record<string, () => void> = { gift: () => {}, coupon: () => {} };

export default function CartView() {
  const [qty, setQty] = useState(1);
  const go = useNavigate();
  const sum = totalPrice(CATALOG, qty);

  function checkout() {
    api.submitOrder(qty);
    go('/shop/receipt');
  }

  function runAction(kind: string) {
    handlers[kind]();
  }

  return (
    <div>
      <p>{format(sum)}</p>
      <input value={qty} onChange={(e) => setQty(Number(e.target.value))} />
      <button onClick={checkout}>주문하기</button>
      <button onClick={() => runAction('gift')}>선물 포장</button>
    </div>
  );
}
