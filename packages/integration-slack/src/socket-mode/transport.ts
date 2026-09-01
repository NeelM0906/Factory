/**
 * A minimal structural interface over a WebSocket so the Socket Mode client (`./client.ts`) never
 * depends on a concrete WebSocket implementation. `createGlobalWebSocketFactory` adapts
 * `globalThis.WebSocket` as the production default; tests inject a scripted fake socket that
 * implements this same shape instead of opening a real network connection.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: never) => void
  ): void;
}

export type WebSocketFactory = (url: string) => SocketLike;

export type WebSocketConstructorLike = new (url: string) => SocketLike;

/**
 * Adapts `globalThis.WebSocket` (or an injected constructor with the same shape) into a
 * {@link WebSocketFactory}. This is not a placeholder: the production Socket Mode client uses
 * this exact factory with no constructor override, and tests override the constructor to run
 * against a scripted fake socket instead of a real connection.
 */
export const createGlobalWebSocketFactory = (
  webSocketConstructor: WebSocketConstructorLike = globalThis.WebSocket as unknown as WebSocketConstructorLike
): WebSocketFactory => {
  return (url: string): SocketLike => new webSocketConstructor(url);
};
