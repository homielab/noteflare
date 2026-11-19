/**
 * Read-only links to one note: /s/<id>#<key>.
 *
 * The app encrypts a snapshot (title and body) with a fresh random key and uploads only
 * the ciphertext. The key travels in the URL fragment, which browsers never send to a
 * server. The page at /s/<id> and GET /api/share/<id> are the only public parts of a
 * deployment; the page is self-contained (no app code, no assets) so nothing else has
 * to be opened in Cloudflare Access.
 */
import type { SharedNote, ShareInfo } from '../shared/types'

export interface ShareRow {
  id: string
  note_id: string
  ciphertext: string
  iv: string
  expires_at: number | null
  created_at: number
}

export const toShareInfo = (r: Pick<ShareRow, 'id' | 'note_id' | 'expires_at' | 'created_at'>): ShareInfo => ({
  id: r.id,
  noteId: r.note_id,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
})

/** The shared ciphertext, or null when the link is unknown, revoked, expired, or its note is in the trash or gone. */
export async function publicShare(db: D1Database, id: string, now = Date.now()): Promise<SharedNote | null> {
  const row = await db
    .prepare(
      `SELECT s.ciphertext, s.iv, s.expires_at FROM shares s
       JOIN notes n ON n.user_id = s.user_id AND n.id = s.note_id
       WHERE s.id = ? AND n.trashed_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)`,
    )
    .bind(id, now)
    .first<Pick<ShareRow, 'ciphertext' | 'iv' | 'expires_at'>>()
  return row ? { ciphertext: row.ciphertext, iv: row.iv, expiresAt: row.expires_at } : null
}

/** Revoke every link to a note (it was trashed or deleted). */
export async function revokeNoteShares(db: D1Database, user: string, noteId: string) {
  await db.prepare('DELETE FROM shares WHERE user_id = ? AND note_id = ?').bind(user, noteId).run()
}

/** Daily cron: remove expired links and links whose note no longer exists. */
export async function purgeShares(db: D1Database, now = Date.now()) {
  await db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run()
  await db
    .prepare('DELETE FROM shares WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.user_id = shares.user_id AND n.id = shares.note_id)')
    .run()
}

/** Security headers for the share page: only its own inline script and style, no referrer, no framing. */
export function sharePageHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
}

const STRINGS = {
  en: {
    title: 'Shared note',
    loading: 'Decrypting…',
    gone: 'This link has expired or was revoked.',
    noKey: 'This link is incomplete: the part after # is missing.',
    bad: "This note couldn't be decrypted. Check that you copied the whole link.",
    net: "Couldn't load the note. Try again in a moment.",
    foot: 'Shared from NoteFlare. Decrypted in your browser; the server only stores ciphertext.',
  },
  vi: {
    title: 'Ghi chú được chia sẻ',
    loading: 'Đang giải mã…',
    gone: 'Liên kết này đã hết hạn hoặc đã bị thu hồi.',
    noKey: 'Liên kết này bị thiếu phần sau dấu #.',
    bad: 'Không giải mã được ghi chú. Hãy kiểm tra bạn đã sao chép đủ cả liên kết.',
    net: 'Không tải được ghi chú. Thử lại sau giây lát.',
    foot: 'Chia sẻ từ NoteFlare. Giải mã ngay trong trình duyệt của bạn; máy chủ chỉ lưu ciphertext.',
  },
  es: {
    title: 'Nota compartida',
    loading: 'Descifrando…',
    gone: 'Este enlace ha caducado o se ha revocado.',
    noKey: 'Este enlace está incompleto: falta la parte después de #.',
    bad: 'No se pudo descifrar esta nota. Comprueba que copiaste el enlace completo.',
    net: 'No se pudo cargar la nota. Inténtalo de nuevo en un momento.',
    foot: 'Compartida desde NoteFlare. Se descifra en tu navegador; el servidor solo guarda texto cifrado.',
  },
  fr: {
    title: 'Note partagée',
    loading: 'Déchiffrement…',
    gone: 'Ce lien a expiré ou a été révoqué.',
    noKey: 'Ce lien est incomplet : il manque la partie après #.',
    bad: 'Impossible de déchiffrer cette note. Vérifiez que vous avez copié le lien en entier.',
    net: 'Impossible de charger la note. Réessayez dans un instant.',
    foot: 'Partagée depuis NoteFlare. Déchiffrée dans votre navigateur ; le serveur ne stocke que du texte chiffré.',
  },
  de: {
    title: 'Geteilte Notiz',
    loading: 'Wird entschlüsselt…',
    gone: 'Dieser Link ist abgelaufen oder wurde widerrufen.',
    noKey: 'Dieser Link ist unvollständig: Der Teil nach # fehlt.',
    bad: 'Diese Notiz ließ sich nicht entschlüsseln. Prüfe, ob du den ganzen Link kopiert hast.',
    net: 'Die Notiz konnte nicht geladen werden. Versuche es gleich noch einmal.',
    foot: 'Geteilt aus NoteFlare. Entschlüsselt in deinem Browser; der Server speichert nur Chiffretext.',
  },
  pt: {
    title: 'Nota compartilhada',
    loading: 'Descriptografando…',
    gone: 'Este link expirou ou foi revogado.',
    noKey: 'Este link está incompleto: falta a parte depois do #.',
    bad: 'Não foi possível descriptografar esta nota. Verifique se você copiou o link inteiro.',
    net: 'Não foi possível carregar a nota. Tente de novo em instantes.',
    foot: 'Compartilhada pelo NoteFlare. Descriptografada no seu navegador; o servidor só guarda texto cifrado.',
  },
}

/**
 * The share page. Plain text only (textContent), so a note can't inject markup.
 * The decryption mirrors src/lib/share.ts: AES-256-GCM, AAD "share:<id>", JSON {title, body}.
 */
export function sharePage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>NoteFlare</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg: #faf8f4; --fg: #22201c; --muted: #77716a; --card: #fff; --line: #e7e2da; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ece8e1; --muted: #9a948b; --card: #201f1c; --line: #34312c; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px; }
  article { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px 28px; }
  h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 12px; overflow-wrap: anywhere; }
  #body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  #status { color: var(--muted); }
  footer { color: var(--muted); font-size: 0.85rem; margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<main>
  <article><h1 id="title"></h1><p id="status"></p><div id="body"></div></article>
  <footer id="foot"></footer>
</main>
<script nonce="${nonce}">
(async () => {
  const S = ${JSON.stringify(STRINGS)};
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const t = S[lang] || S.en;
  document.documentElement.lang = S[lang] ? lang : 'en';
  const $ = (id) => document.getElementById(id);
  $('foot').textContent = t.foot;
  $('status').textContent = t.loading;
  const fail = (msg) => { $('status').textContent = msg; };
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const id = location.pathname.split('/')[2] || '';
  const key = location.hash.slice(1);
  if (!/^(?:[A-Za-z0-9_-]{11}|[A-Za-z0-9_-]{22})$/.test(id)) return fail(t.gone);
  if (!/^(?:[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/.test(key)) return fail(t.noKey);
  let res;
  try { res = await fetch('/api/share/' + id, { cache: 'no-store', credentials: 'omit' }); } catch { return fail(t.net); }
  if (res.status === 404) return fail(t.gone);
  if (!res.ok) return fail(t.net);
  try {
    const data = await res.json();
    const k = await crypto.subtle.importKey('raw', b64(key), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(data.iv), additionalData: new TextEncoder().encode('share:' + id) }, k, b64(data.ciphertext));
    const note = JSON.parse(new TextDecoder().decode(pt));
    const title = typeof note.title === 'string' ? note.title : '';
    $('title').textContent = title || t.title;
    document.title = (title || t.title) + ' · NoteFlare';
    $('body').textContent = typeof note.body === 'string' ? note.body : '';
    $('status').remove();
  } catch { fail(t.bad); }
})();
</script>
</body>
</html>`
}
