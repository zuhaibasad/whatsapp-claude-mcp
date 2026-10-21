export { ACCEPT_PHRASE } from '../core/constants.js';

export const RISK_WARNING = `
IMPORTANT - please read before continuing

  * Using WhatsApp through an unofficial linked device is against WhatsApp's
    Terms of Service. Your number can be restricted or banned.
  * The other people in your chats did not consent to their messages being
    stored on this computer or read by an AI.
  * When Claude reads your messages through the wa-bridge tools, the message
    text is sent to Anthropic.
  * wa-bridge is read-only: it never sends messages, never marks anything as
    read, and never shows you as online.
  * Your data stays in the .wa-bridge/ folder, encrypted. The key is kept in
    your operating system keychain.
`;
