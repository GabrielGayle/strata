// The client proposal page lives at /p in the same app; its design comes in
// the share code after # (see core/share.ts), so nothing is read from storage.

export const PROPOSAL_PATH = '/p';

export function isProposalPath(pathname: string): boolean {
  return pathname === PROPOSAL_PATH || pathname === `${PROPOSAL_PATH}/`;
}
