import React from 'react'
import { twMerge } from 'tailwind-merge'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: React.ReactNode
  labelId?: string
  labelClassName?: string
  wrapperClassName?: string
  helperText?: React.ReactNode
}

export const Input = ({
  id,
  label,
  labelId: providedLabelId,
  labelClassName = '',
  wrapperClassName = '',
  helperText,
  className = '',
  'aria-describedby': ariaDescribedBy,
  ...props
}: InputProps) => {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const computedLabelId = providedLabelId ?? `${inputId}-label`
  const helperId = helperText ? `${inputId}-helper` : undefined
  const describedBy =
    [ariaDescribedBy, helperId].filter(Boolean).join(' ') || undefined

  const inputElement = (
    <input
      id={inputId}
      aria-describedby={describedBy}
      className={twMerge(
        'border rounded px-3 py-2 w-full bg-white placeholder:text-gray-600',
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

export default Input
