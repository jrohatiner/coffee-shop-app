import React from 'react'
import { twMerge } from 'tailwind-merge'

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  className?: string
  contextLabel?: string
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, className, contextLabel, ...props }, ref) => {
    const trimmedContext = contextLabel?.trim()
    return (
      <button
        ref={ref}
        className={twMerge(
          'px-3 py-2 border border-control rounded bg-white text-gray-900 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
          className
        )}
        {...props}
      >
        {children}
        {trimmedContext ? (
          <span className="sr-only">{` ${trimmedContext}`}</span>
        ) : null}
      </button>
    )
  }
)
Button.displayName = 'Button'

export default Button
