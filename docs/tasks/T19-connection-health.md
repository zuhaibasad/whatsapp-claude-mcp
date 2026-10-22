# T19 — Connection health (watchdog gaps) + proxy support

**Model tier:** Sonnet · **Owned files:** `src/daemon/wa/wa-client.ts`, `src/daemon/runner.ts`, `src/daemon/backoff.ts`, new `src/daemon/health.ts`, and their tests. Do not edit `normalize.ts` (T18) or `src/host/**` / `src/mcp/**` (T20); expose what T20 needs via exported functions and meta keys described below.

## Findings (orchestrator, Baileys rc14 `lib/Socket/socket.js`)
Baileys already ends the socket with `connectionLost` when no frame arrives within `keepAliveIntervalMs + 5s` (30 s default), and our backoff reconnects. So the transport watchdog exists. Do **not** duplicate it. What is missing:

## Deliverables
1. **Health tracking** (`health.ts`):
   - Record `lastFrameAt` (via `sock.ws.on('frame', …)` if `ws` is accessible in rc14 typings; else via any incoming event), `lastAppEventAt` (any messages/chats/contacts/receipt-type event), `connectedAt` and `reconnects` (rolling 24 h count).
   - Write them to meta keys `health_last_frame_at`, `health_last_app_event_at`, `health_reconnects_24h` and `health_last_reason`, throttled to one write per 10 s. T20's diagnose reads these.
2. **Sleep/resume detection:**
   - A 15 s interval compares wall-clock to monotonic (`performance.now()`) drift. A jump greater than 60 s means the machine slept.
   - On a jump, if the socket is not mid-connect, force a clean reconnect: close without logout, then `connect()` immediately without backoff, once. The collector goes back to `catching_up`, so briefs wait for the offline messages.
   - Unit-test with injected clocks.
3. **App-level stall:**
   - If the socket is open but there is no app event *and* no frame for `max(4 × keepAliveIntervalMs, 5 min)`, force one reconnect (counts toward backoff).
   - A quiet account with frames still arriving is **not** restarted, because Baileys pings keep frames flowing.
4. **Honest state:** the collector state becomes `reconnecting` when a forced reconnect happens, and `live` only after `caught_up` again (existing logic).
5. **Proxy support (#9):**
   - If `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY` is set and `NO_PROXY` does not match `web.whatsapp.com`, create an `HttpsProxyAgent` (`https-proxy-agent` 9.1.0 is installed) and pass it as the Baileys socket `agent` and `fetchAgent` options. Check the rc14 `SocketConfig` typings for the exact names.
   - Log `proxy: on` / `off` without the URL credentials.
   - Expose `proxyInfo(): { enabled: boolean; host: string | null }`, with the host only and no user/password, for diagnose.
6. **Read-only guard:** accessing `sock.ws` for listening only is OK. Never call send-type APIs. Keep `READ_ONLY_SOCKET_CONFIG` intact (the test asserts it).

## Tests
Fake timers/clocks:
- Sleep jump → exactly one immediate reconnect.
- Stall → one reconnect, and no reconnect while frames keep coming.
- Reconnect count over 24 h.
- Meta writes are throttled.
- Proxy env parsing (`NO_PROXY` match, credentials stripped from the host).
- The socket config gets the agent only when a proxy is set.
- The guard test still passes.

## Acceptance
`npm run check` + `npm run build` pass. Notes in `docs/notes/T19.md` (meta keys, exported functions for T20).
