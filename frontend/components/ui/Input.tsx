import React from 'react'
import { twMerge } from 'tailwind-merge'

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={twMerge(
      'border border-control rounded px-3 py-2 w-full bg-white text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export default Input
