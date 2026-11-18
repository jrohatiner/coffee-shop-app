import React from 'react'
import { twMerge } from 'tailwind-merge'

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ children, className, ...props }, ref) => (
  <button
    ref={ref}
    className={twMerge(
      'px-3 py-2 border border-control rounded bg-white text-gray-900 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
      className
    )}
    {...props}
  >
    {children}
  </button>
))
Button.displayName = 'Button'

export default Button
