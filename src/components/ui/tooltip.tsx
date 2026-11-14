import * as React from 'react'
import { Tooltip as T } from 'radix-ui'
import { cn } from '@/lib/utils'

const TooltipProvider = T.Provider

function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          sideOffset={6}
          className={cn('z-50 origin-(--radix-tooltip-content-transform-origin) rounded-md bg-foreground px-2 py-1 text-xs text-background duration-150 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95')}
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}

export { Tooltip, TooltipProvider }
