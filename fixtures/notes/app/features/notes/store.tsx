import { createContext, useContext, useReducer, type ReactNode } from 'react';

export interface Note { id: number; text: string }
type Action = { type: 'add'; text: string } | { type: 'remove'; id: number };

function reducer(notes: Note[], a: Action): Note[] {
  if (a.type === 'add') return [...notes, { id: notes.length + 1, text: a.text }];
  return notes.filter((n) => n.id !== a.id);
}

const Ctx = createContext<{ notes: Note[]; dispatch: (a: Action) => void } | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [notes, dispatch] = useReducer(reducer, []);
  return <Ctx.Provider value={{ notes, dispatch }}>{children}</Ctx.Provider>;
}

export const useNotes = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('NotesProvider 밖');
  return v;
};
