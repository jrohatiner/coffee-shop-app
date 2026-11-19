import React from 'react'
import { twMerge } from 'tailwind-merge'

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: React.ReactNode
  labelId?: string
  labelClassName?: string
  wrapperClassName?: string
  helperText?: React.ReactNode
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      id,
      label,
      labelId: providedLabelId,
      labelClassName = '',
      wrapperClassName = '',
      helperText,
      className = '',
      children,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref
  ) => {
    const generatedId = React.useId()
    const selectId = id ?? generatedId
    const computedLabelId = providedLabelId ?? `${selectId}-label`
    const helperId = helperText ? `${selectId}-helper` : undefined
    const describedBy =
      [ariaDescribedBy, helperId].filter(Boolean).join(' ') || undefined

    const selectElement = (
      <select
        ref={ref}
        id={selectId}
        aria-describedby={describedBy}
        className={twMerge(
          'border border-control rounded px-3 py-2 bg-white text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
          className
        )}
        {...props}
      >
        {children}
      </select>
    )

    if (!label && !helperText) {
      return selectElement
    }

    return (
      <div className={wrapperClassName || 'space-y-1'}>
        {label && (
          <label
            id={computedLabelId}
            htmlFor={selectId}
            className={twMerge('block text-sm font-medium text-gray-800', labelClassName)}
          >
            {label}
          </label>
        )}
        {selectElement}
        {helperText && (
          <p id={helperId} className="text-sm text-gray-600">
            {helperText}
          </p>
        )}
      </div>
    )
  }
)
Select.displayName = 'Select'

export default Select
