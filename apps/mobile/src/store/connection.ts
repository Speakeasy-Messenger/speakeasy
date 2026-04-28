import { create } from 'zustand';
import type { WsState } from '../ws/client.js';

export interface ConnectionState {
  state: WsState;
  lastError: string | undefined;
  setState: (s: WsState) => void;
  setError: (msg: string | undefined) => void;
}

export const useConnection = create<ConnectionState>((set) => ({
  state: 'idle',
  lastError: undefined,
  setState: (state) => set({ state }),
  setError: (lastError) => set({ lastError }),
}));
