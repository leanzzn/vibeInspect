import { useState } from 'react';

export function Receipt({ onDone }: { onDone: () => void }) {
  const [seen, setSeen] = useState(false);

  const close = () => {
    setSeen(true);
    onDone();
  };

  return <button onClick={close} disabled={seen}>닫기</button>;
}
