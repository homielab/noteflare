/** Sample notes and banner text of the demo build (English and Vietnamese notes; other languages get English). */
import type { NoteColor } from '../crypto'

export const DEMO_PASSPHRASE = 'try noteflare'
export const DEMO_EMAIL = 'demo@noteflare.app'
export const DEPLOY_GUIDE_URL = 'https://noteflare.homielab.com/start/deploy/'

export interface SampleNote {
  title: string
  body: string
  color: NoteColor
  labels: string[]
  pinned: boolean
  archived: boolean
}

const note = (title: string, body: string, opts: Partial<SampleNote> = {}): SampleNote => ({
  title,
  body,
  color: 'default',
  labels: [],
  pinned: false,
  archived: false,
  ...opts,
})

const en: SampleNote[] = [
  note(
    'Welcome to the NoteFlare demo',
    "Everything here runs in your browser: notes are encrypted with a key that never leaves it, just like on your own deployment.\n\n- Click a note to edit it\n- Try **Select**, the labels above the notes and the search at the top\n- Lock it with the lock button, then unlock with the passphrase in the banner\n\nNothing you write here is sent anywhere.",
    { pinned: true, color: 'sky' },
  ),
  note('Groceries', '- [x] Coffee beans\n- [ ] Oat milk\n- [ ] Lemons\n- [ ] Rice\n- [ ] Basil', { labels: ['Home'], color: 'sage', pinned: true }),
  note(
    'Deploy notes',
    'Ship it with one command:\n\n```bash\nbun run deploy\n```\n\n```ts\nconst res = await fetch("/api/v1/notes", {\n  headers: { Authorization: `Bearer ${token}` },\n})\n```',
    { labels: ['Work'], color: 'slate' },
  ),
  note('Weekend trip', '**Saturday**: train at 8:10, hike the ridge trail\n**Sunday**: market, then home by 6\n\n- [ ] Book the cabin\n- [ ] Charge the camera', { labels: ['Travel'], color: 'sand' }),
  note('Book list', '1. *The Left Hand of Darkness*\n2. *A Psalm for the Wild-Built*\n3. *Piranesi*', { labels: ['Reading'], color: 'lilac' }),
  note('Meeting: Q3 plan', '- Launch the docs site\n- Collect feedback from early users\n- [ ] Send the summary to the team', { labels: ['Work'] }),
  note('Idea', 'A note app that keeps the server out of the loop. Wait, that is this one.', { color: 'rose' }),
  note('Quote', '> Simplicity is prerequisite for reliability.\n>\n> Edsger W. Dijkstra', { color: 'clay' }),
  note('Wi-Fi at the cabin', 'Network: `PineView`\nPassword: ask the host', { labels: ['Travel'] }),
  note('Old packing list', '- [x] Tent\n- [x] Stove\n- [x] Headlamp', { archived: true, labels: ['Travel'] }),
]

const vi: SampleNote[] = [
  note(
    'Chào mừng đến bản demo NoteFlare',
    'Mọi thứ ở đây chạy trong trình duyệt của bạn: ghi chú được mã hóa bằng một khóa không bao giờ rời khỏi nó, giống hệt bản triển khai của riêng bạn.\n\n- Bấm vào một ghi chú để sửa\n- Thử **Chọn**, các nhãn phía trên ghi chú và ô tìm kiếm ở trên cùng\n- Khóa bằng nút ổ khóa, rồi mở bằng cụm mật khẩu trên thanh demo\n\nKhông có gì bạn viết ở đây được gửi đi đâu cả.',
    { pinned: true, color: 'sky' },
  ),
  note('Đi chợ', '- [x] Cà phê hạt\n- [ ] Sữa yến mạch\n- [ ] Chanh\n- [ ] Gạo\n- [ ] Húng quế', { labels: ['Nhà'], color: 'sage', pinned: true }),
  note(
    'Ghi chú triển khai',
    'Triển khai bằng một lệnh:\n\n```bash\nbun run deploy\n```\n\n```ts\nconst res = await fetch("/api/v1/notes", {\n  headers: { Authorization: `Bearer ${token}` },\n})\n```',
    { labels: ['Công việc'], color: 'slate' },
  ),
  note('Đi chơi cuối tuần', '**Thứ Bảy**: tàu lúc 8:10, leo núi\n**Chủ nhật**: đi chợ, về nhà trước 6 giờ\n\n- [ ] Đặt phòng\n- [ ] Sạc máy ảnh', { labels: ['Du lịch'], color: 'sand' }),
  note('Sách muốn đọc', '1. *Dế Mèn phiêu lưu ký*\n2. *Nhà giả kim*\n3. *Piranesi*', { labels: ['Đọc sách'], color: 'lilac' }),
  note('Họp: kế hoạch quý 3', '- Ra mắt trang tài liệu\n- Thu thập góp ý từ người dùng đầu tiên\n- [ ] Gửi tóm tắt cho cả nhóm', { labels: ['Công việc'] }),
  note('Ý tưởng', 'Một ứng dụng ghi chú mà máy chủ không đọc được. Khoan, chính là cái này.', { color: 'rose' }),
  note('Trích dẫn', '> Sự đơn giản là điều kiện tiên quyết của độ tin cậy.\n>\n> Edsger W. Dijkstra', { color: 'clay' }),
  note('Wi-Fi ở nhà nghỉ', 'Mạng: `PineView`\nMật khẩu: hỏi chủ nhà', { labels: ['Du lịch'] }),
  note('Danh sách đồ cũ', '- [x] Lều\n- [x] Bếp\n- [x] Đèn đội đầu', { archived: true, labels: ['Du lịch'] }),
]

export const sampleNotes = (lang: string): SampleNote[] => (lang === 'vi' ? vi : en)

type BannerText = { notice: string; passphrase: string; deploy: string; reset: string; resetConfirm: string }

const banner: Record<string, BannerText> = {
  en: { notice: 'Demo: notes stay in this browser', passphrase: 'Passphrase', deploy: 'Deploy your own', reset: 'Reset demo', resetConfirm: 'Reset the demo? Your changes are removed and the sample notes come back.' },
  vi: { notice: 'Bản demo: ghi chú chỉ nằm trong trình duyệt này', passphrase: 'Cụm mật khẩu', deploy: 'Tự triển khai', reset: 'Đặt lại demo', resetConfirm: 'Đặt lại demo? Thay đổi của bạn sẽ bị xóa và các ghi chú mẫu quay lại.' },
  es: { notice: 'Demo: las notas se quedan en este navegador', passphrase: 'Frase de contraseña', deploy: 'Despliega la tuya', reset: 'Reiniciar demo', resetConfirm: '¿Reiniciar la demo? Se borran tus cambios y vuelven las notas de ejemplo.' },
  fr: { notice: 'Démo : les notes restent dans ce navigateur', passphrase: 'Phrase secrète', deploy: 'Déployer la vôtre', reset: 'Réinitialiser la démo', resetConfirm: 'Réinitialiser la démo ? Vos modifications sont supprimées et les notes d’exemple reviennent.' },
  de: { notice: 'Demo: Notizen bleiben in diesem Browser', passphrase: 'Passphrase', deploy: 'Eigene Instanz einrichten', reset: 'Demo zurücksetzen', resetConfirm: 'Demo zurücksetzen? Deine Änderungen werden gelöscht und die Beispielnotizen kommen zurück.' },
  pt: { notice: 'Demo: as notas ficam neste navegador', passphrase: 'Frase secreta', deploy: 'Implante a sua', reset: 'Reiniciar demo', resetConfirm: 'Reiniciar a demo? Suas alterações são apagadas e as notas de exemplo voltam.' },
}

export const bannerText = (lang: string): BannerText => banner[lang] ?? banner.en
