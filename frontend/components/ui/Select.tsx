import React from 'react'
import { twMerge } from 'tailwind-merge'

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ children, className, ...props }, ref) => (
  <select
    ref={ref}
    className={twMerge(
      'border border-control rounded px-3 py-2 bg-white text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
      className
    )}
    {...props}
  >
    {children}
  </select>
))
Select.displayName = 'Select'

export default Select
