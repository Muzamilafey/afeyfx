import { useEffect, useRef, useState } from 'react';
import { getSocket } from '../websocket/socket';
import { tokenStore } from '../services/api';

/** Subscribe to a Socket.IO event for the lifetime of the component. */
export function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const fn = (p: T) => ref.current(p);
    s.on(event, fn);
    return () => {
      s.off(event, fn);
    };
  }, [event]);
}

export function useSocketStatus() {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    const attach = () => {
      s = getSocket();
      s?.on('connect', on);
      s?.on('disconnect', off);
      setConnected(!!s?.connected);
    };
    attach();
    const unsub = tokenStore.subscribe(() => attach());
    return () => {
      s?.off('connect', on);
      s?.off('disconnect', off);
      unsub();
    };
  }, []);
  return connected;
}
