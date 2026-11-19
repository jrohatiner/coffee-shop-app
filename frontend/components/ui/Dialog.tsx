import React, { useEffect, useRef } from 'react'

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  'aria-labelledby'?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export const Dialog = ({
  open,
  onOpenChange,
  children,
  'aria-labelledby': ariaLabelledBy,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: DialogProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const isProgrammaticCloseRef = useRef(false)
  const pendingCloseFromCancelRef = useRef(false)

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return

    const previousActiveElement = document.activeElement
    pendingCloseFromCancelRef.current = false

    if (!dialog.open) {
      dialog.showModal()
    }

    return () => {
      if (dialog.open) {
        isProgrammaticCloseRef.current = true
        dialog.close()
        isProgrammaticCloseRef.current = false
      }
      if (
        previousActiveElement instanceof HTMLElement &&
        previousActiveElement.isConnected
      ) {
        previousActiveElement.focus()
      }
    }
  }, [open])

  if (!open) return null

  const handleCancel = (event: React.SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault()
    if (!event.defaultPrevented) {
      pendingCloseFromCancelRef.current = true
    }
    onOpenChange(false)
  }

  const handleClose = () => {
    if (pendingCloseFromCancelRef.current) {
      pendingCloseFromCancelRef.current = false
      return
    }
    if (!open || isProgrammaticCloseRef.current || dialogRef.current?.open) {
      return
    }
    onOpenChange(false)
  }

  const handleClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) {
      onOpenChange(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className="p-0 rounded shadow bg-transparent backdrop:bg-black/30"
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleClick}
    >
      <div className="bg-white rounded shadow p-4 min-w-[320px]">
        {children}
      </div>
    </dialog>
  )
}

export default Dialog
