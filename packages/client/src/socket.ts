/** The subset of the WebSocket API used here, satisfied by both the browser
 *  built-in and the Node `ws` package. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

export const OPEN = 1;

export const defaultSocketFactory: SocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('no global WebSocket; pass a socketFactory');
  return new Ctor(url);
};
