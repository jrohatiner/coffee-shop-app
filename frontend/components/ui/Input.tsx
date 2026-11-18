import React from 'react'
import { twMerge } from 'tailwind-merge'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  className?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', 'aria-invalid': ariaInvalid, ...props }, ref) => {
    const isInvalid = ariaInvalid === true || ariaInvalid === 'true'
    const normalizedAriaInvalid =
      ariaInvalid === true
        ? true
        : ariaInvalid === false
          ? false
          : ariaInvalid

    return (
      <input
        ref={ref}
        aria-invalid={normalizedAriaInvalid}
        className={twMerge(
          'border border-gray-300 rounded px-3 py-2 w-full bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-600',
          isInvalid && 'border-red-700 focus:ring-red-700',
          className
        )}
        {...props}
      />
    )
  }
)

Input.displayName = 'Input'

export default Input
