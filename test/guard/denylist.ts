// Read-only guard: the list of WhatsApp write APIs that must never appear in src/.
// Source of truth: docs/PLAN.md section 7. Do not shorten these lists.

/** Exact names from PLAN section 7. */
export const WRITE_API_DENYLIST: readonly string[] = [
  'sendMessage',
  'relayMessage',
  'sendReceipt',
  'sendReceipts',
  'readMessages',
  'sendPresenceUpdate',
  'presenceSubscribe',
  'chatModify',
  'star',
  'groupCreate',
  'groupParticipantsUpdate',
  'groupLeave',
  'groupToggleEphemeral',
  'groupSettingUpdate',
  'groupJoinApprovalMode',
  'groupMemberAddMode',
  'removeProfilePicture',
  'updateBlockStatus',
  'addOrEditContact',
  'removeContact',
  'sendWAMBuffer',
  'rejectCall',
  'offerCall',
  'appPatch',
  'resyncAppState',
  'downloadMediaMessage',
  'fetchMessageHistory',
  'requestPlaceholderResend',
];

/** Prefix/shape patterns from PLAN section 7 (groupUpdate*, update*Privacy, newsletter*, ...). */
export const WRITE_API_PATTERNS: readonly RegExp[] = [
  /^groupUpdate/,
  /^groupInvite/,
  /^groupAcceptInvite/,
  /^groupRevokeInvite/,
  /^updateProfile/,
  /^update\w*Privacy$/,
  /^addLabel/,
  /^removeLabel/,
  /^newsletter/,
];

/**
 * Additional write-capable socket methods found in baileys 7.0.0-rc14 that PLAN section 7 does
 * not list by name. Denied on top of the PLAN list (defence in depth). Kept separate so that
 * WRITE_API_DENYLIST stays exactly the PLAN list.
 */
export const EXTRA_WRITE_API_DENYLIST: readonly string[] = [
  'sendNode',
  'sendRawMessage',
  'sendMessageAck',
  'sendRetryRequest',
  'sendUnifiedSession',
  'sendPeerDataOperationMessage',
  'createCallLink',
  'groupRequestParticipantsUpdate',
  'addChatLabel',
  'addMessageLabel',
  'removeChatLabel',
  'removeMessageLabel',
  'addOrEditQuickReply',
  'removeQuickReply',
  'removeCoverPhoto',
  'updateMediaMessage',
  'updateMemberLabel',
  'updateCoverPhoto',
  'updateDefaultDisappearingMode',
  'updateBussinesProfile',
  'uploadPreKeys',
  'uploadPreKeysToServerIfRequired',
  'rotateSignedPreKey',
  'waUploadToServer',
  'issuePrivacyTokens',
];

export const EXTRA_WRITE_API_PATTERNS: readonly RegExp[] = [
  /^community(?!Metadata$|FetchAllParticipating$|FetchLinkedGroups$|GetInviteInfo$|RequestParticipantsList$)/,
  /^product(Create|Update|Delete)/,
  /^subscribeNewsletter/,
];

/**
 * Allowed only inside a function named `unlink` in src/daemon/wa/wa-client.ts
 * (approved 2026-10-21, PLAN section 7).
 */
export const ALLOWED_EXCEPTIONS: readonly string[] = ['logout'];
export const ALLOWED_EXCEPTION_FILE = 'src/daemon/wa/wa-client.ts';
export const ALLOWED_EXCEPTION_FUNCTION = 'unlink';

/** True if `name` is a denied WhatsApp write API (PLAN list, patterns, or extras). */
export function isWriteApi(name: string): boolean {
  return (
    WRITE_API_DENYLIST.includes(name) ||
    EXTRA_WRITE_API_DENYLIST.includes(name) ||
    WRITE_API_PATTERNS.some((re) => re.test(name)) ||
    EXTRA_WRITE_API_PATTERNS.some((re) => re.test(name))
  );
}
