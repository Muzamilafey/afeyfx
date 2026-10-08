import { io, type Socket } from 'socket.io-client';
import { tokenStore } from '../services/api';

let socket: Socket | null = null;

/** Single shared Socket.IO connection, authenticated with the current access token. */
export function getSocket(): Socket | null {
  const token = tokenStore.get();
  if (!token) return null;
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket'], auth: (cb) => cb({ token: tokenStore.get() }), reconnectionDelayMax: 10_000 });
  }
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}
