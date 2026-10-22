export {};
declare global {
  interface Window {
    /** Injected by the HTTP route when served as a browser page. */
    __WA_HTTP__?: { csrf: string };
    /** Injected into the HTML by the MCP resource read (single-use, user-proof credential). */
    __WA_NONCE__?: string;
    /** Separate single-use credential for disconnect (panel only). */
    __WA_DISCONNECT_NONCE__?: string;
  }
}
