/**
 * Hide most of an email address where other people may see the screen (the lock screen):
 * "minh.tran@example.com" → "m•••••••n@example.com". The domain stays, so the owner still
 * recognises which account this is.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return `${local[0]}•${domain}`
  return `${local[0]}${'•'.repeat(Math.min(local.length - 2, 8))}${local[local.length - 1]}${domain}`
}
