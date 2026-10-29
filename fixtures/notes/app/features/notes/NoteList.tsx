import { useCallback, useEffect } from 'react';
import { useNotes } from './store';
import { summarize } from '@/utils/text';
import { countWords } from '../../utils';

const NoteList = () => {
  const { notes, dispatch } = useNotes();
  useEffect(() => {
    document.title = `메모 ${notes.length}개`;
  }, [notes]);
  const remove = useCallback((id: number) => dispatch({ type: 'remove', id }), [dispatch]);
  return (
    <ul>
      {notes.map((n) => (
        <li key={n.id}>
          {summarize(n.text)} ({countWords(n.text)}단어)
          <button onClick={() => remove(n.id)}>삭제</button>
        </li>
      ))}
    </ul>
  );
};
export default NoteList;
