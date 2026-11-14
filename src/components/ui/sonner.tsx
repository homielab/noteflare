import { Toaster as Sonner, type ToasterProps } from 'sonner'

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-left"
      // Phones: sit above the New note button rather than on top of it.
      mobileOffset={{ bottom: 'calc(6rem + env(safe-area-inset-bottom))' }}
      toastOptions={{
        classNames: {
          toast: '!bg-foreground !text-background !border-0 !rounded-lg !font-sans',
          actionButton: '!bg-transparent !text-inverse-accent !font-semibold',
        },
      }}
      {...props}
    />
  )
}
