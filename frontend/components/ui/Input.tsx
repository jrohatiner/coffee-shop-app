import React from 'react'
import { twMerge } from 'tailwind-merge'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: React.ReactNode
  labelId?: string
  labelClassName?: string
  wrapperClassName?: string
  helperText?: React.ReactNode
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      id,
      label,
      labelId: providedLabelId,
      labelClassName = '',
      wrapperClassName = '',
      helperText,
      className = '',
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref
  ) => {
    const generatedId = React.useId()
    const inputId = id ?? generatedId
    const computedLabelId = providedLabelId ?? `${inputId}-label`
    const helperId = helperText ? `${inputId}-helper` : undefined
    const describedBy =
      [ariaDescribedBy, helperId].filter(Boolean).join(' ') || undefined

    const inputElement = (
      <input
        ref={ref}
        id={inputId}
        aria-describedby={describedBy}
        className={twMerge(
          'border border-control rounded px-3 py-2 w-full bg-white text-gray-900 placeholder:text-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
          className
        )}
        {...props}
      />
    )

    if (!label && !helperText) {
      return inputElement
    }

    return (
      <div className={wrapperClassName || 'space-y-1'}>
        {label && (
          <label
            id={computedLabelId}
            htmlFor={inputId}
            className={twMerge('block text-sm font-medium text-gray-800', labelClassName)}
          >
            {label}
          </label>
        )}
        {inputElement}
        {helperText && (
          <p id={helperId} className="text-sm text-gray-600">
            {helperText}
          </p>
        )}
      </div>
    )
  }
)
Input.displayName = 'Input'

export default Input
