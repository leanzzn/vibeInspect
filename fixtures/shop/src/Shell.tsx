import { BrowserRouter, Route, Routes } from 'react-router-dom';
import CartView from './views/CartView';
import { Receipt } from './views/Receipt';

export function Shell() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/shop">
          <Route path="cart" element={<CartView />} />
          <Route path="receipt" element={<Receipt onDone={() => {}} />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
