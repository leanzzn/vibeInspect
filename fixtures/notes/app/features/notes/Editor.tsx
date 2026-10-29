import { useState } from 'react';
import { useNotes } from './store';
import { countWords } from '../../utils';

export function Editor({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState('');
  const { dispatch } = useNotes();
  function save() {
    if (countWords(text) === 0) return;
    dispatch({ type: 'add', text });
    onSaved();
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit">저장</button>
    </form>
  );
}
