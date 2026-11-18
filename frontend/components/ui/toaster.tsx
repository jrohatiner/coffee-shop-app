import React from 'react'
import * as Toast from '@radix-ui/react-toast'
import { useToast } from './use-toast'

export const Toaster = () => {
  const { toasts, dismiss } = useToast()

  return (
    <Toast.Provider label="Notification" swipeDirection="right" duration={5000}>
      {toasts.map((t) => {
        const isDestructive = t.variant === 'destructive'
        const toastType = isDestructive ? 'foreground' : 'background'

        return (
          <Toast.Root
            key={t.id}
            open={t.open}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id)
            }}
            type={toastType}
            duration={t.duration}
            data-variant={t.variant}
            data-toast-type={toastType}
            className={`border rounded shadow-lg p-4 flex items-start justify-between gap-3 focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              isDestructive
                ? 'bg-red-50 border-red-700 text-red-900 focus:ring-red-700'
                : 'bg-white border-gray-300 text-gray-900 focus:ring-blue-600'
            }`}
          >
            <div className="flex-1 min-w-0">
              <Toast.Title
                className={`font-semibold text-sm leading-5 ${
                  isDestructive ? 'text-red-900' : 'text-gray-900'
                }`}
              >
                {t.title}
              </Toast.Title>
              {t.description ? (
                <>
                  <span className="sr-only">. </span>
                  <Toast.Description
                    className={`text-sm leading-5 mt-1 ${
                      isDestructive ? 'text-red-800' : 'text-gray-700'
                    }`}
                  >
                    {t.description}
                  </Toast.Description>
                </>
              ) : null}
            </div>
            <Toast.Close
              aria-label={`Close ${t.title}`}
              className={`px-3 py-1.5 text-xs font-medium border rounded shrink-0 focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                isDestructive
                  ? 'border-red-700 bg-white text-red-900 hover:bg-red-100 focus:ring-red-700'
                  : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-100 focus:ring-blue-600'
              }`}
            >
              Close
            </Toast.Close>
          </Toast.Root>
        )
      })}
      <Toast.Viewport
        hotkey={['F8']}
        label="Notifications ({hotkey})"
        className="fixed bottom-0 right-0 z-50 flex flex-col gap-2 p-4 w-full max-w-sm max-h-screen overflow-hidden outline-none focus:ring-2 focus:ring-blue-600 focus:ring-inset"
      />
    </Toast.Provider>
  )
}

export default Toaster
