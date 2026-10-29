import { useState } from 'react';
import { NotesProvider } from './features/notes/store';
import NoteList from './features/notes/NoteList';
import { Editor } from './features/notes/Editor';
import OldBanner from './legacy/OldBanner';

export default function Root() {
  const [tab, setTab] = useState<'list' | 'edit'>('list');
  return (
    <NotesProvider>
      <OldBanner />
      <button onClick={() => setTab('list')}>목록</button>
      <button onClick={() => setTab('edit')}>쓰기</button>
      {tab === 'list' ? <NoteList /> : <Editor onSaved={() => setTab('list')} />}
    </NotesProvider>
  );
}
