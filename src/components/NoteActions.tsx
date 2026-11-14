import type { ReactNode } from 'react'
import { Archive, ArchiveRestore, Pin, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import type { Note, NotePatch } from '@/lib/notes'
import { ColorPicker } from './ColorPicker'

interface Props {
  note: Note
  onChange: (patch: NotePatch) => void
  onDeleteForever: () => void
}

function Act({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
      >
        {children}
      </Button>
    </Tooltip>
  )
}

export function PinButton({ note, onChange }: Pick<Props, 'note' | 'onChange'>) {
  const { t } = useI18n()
  if (note.trashedAt) return null
  return (
    <Act label={note.pinned ? t('act.unpin') : t('act.pin')} onClick={() => onChange({ pinned: !note.pinned })}>
      <Pin className={note.pinned ? 'fill-current' : undefined} />
    </Act>
  )
}

export function NoteActions({ note, onChange, onDeleteForever }: Props) {
  const { t } = useI18n()
  if (note.trashedAt) {
    return (
      <>
        <Act label={t('act.restore')} onClick={() => onChange({ trashedAt: null })}>
          <RotateCcw />
        </Act>
        <Act label={t('act.deleteForever')} onClick={onDeleteForever}>
          <Trash2 />
        </Act>
      </>
    )
  }
  return (
    <>
      <ColorPicker value={note.color} onChange={(color) => onChange({ color })} />
      <Act
        label={note.archived ? t('act.unarchive') : t('act.archive')}
        onClick={() => onChange({ archived: !note.archived, pinned: false })}
      >
        {note.archived ? <ArchiveRestore /> : <Archive />}
      </Act>
      <Act label={t('act.trash')} onClick={() => onChange({ trashedAt: Date.now(), pinned: false })}>
        <Trash2 />
      </Act>
    </>
  )
}
