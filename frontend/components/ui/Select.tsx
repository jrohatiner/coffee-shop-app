import React from 'react'
import { twMerge } from 'tailwind-merge'

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: React.ReactNode
  hideLabel?: boolean
  labelId?: string
  labelClassName?: string
  wrapperClassName?: string
  helperText?: React.ReactNode
  error?: string
  errorId?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      id,
      label,
      hideLabel = false,
      labelId: providedLabelId,
      labelClassName = '',
      wrapperClassName = '',
      helperText,
      error,
      errorId,
      className = '',
      children,
      'aria-invalid': ariaInvalid,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref
  ) => {
    const generatedId = React.useId()
    const selectId = id ?? generatedId
    const computedLabelId = providedLabelId ?? `${selectId}-label`
    const helperId = helperText ? `${selectId}-helper` : undefined
    const resolvedErrorId = error ? (errorId ?? `${selectId}-error`) : undefined
    const hasError =
      Boolean(error) || ariaInvalid === true || ariaInvalid === 'true'
    const resolvedAriaInvalid = error
      ? 'true'
      : ariaInvalid === true
        ? 'true'
        : ariaInvalid === false
          ? 'false'
          : ariaInvalid
    const describedBy =
      [ariaDescribedBy, helperId, resolvedErrorId].filter(Boolean).join(' ') ||
      undefined

    const selectElement = (
      <select
        ref={ref}
        id={selectId}
        aria-invalid={resolvedAriaInvalid}
        aria-describedby={describedBy}
        className={twMerge(
          'border border-control rounded px-3 py-2 bg-white text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
          hasError && 'border-red-700 focus-visible:outline-red-700',
          className
        )}
        {...props}
      >
        {children}
      </select>
    )

    if (!label && !helperText && !error) {
      return selectElement
    }

    return (
      <div className={wrapperClassName || (hideLabel ? '' : 'space-y-1')}>
        {label && (
          <label
            id={computedLabelId}
            htmlFor={selectId}
            className={twMerge(
              hideLabel ? 'sr-only' : 'block text-sm font-medium text-gray-800',
              labelClassName
            )}
          >
            {label}
          </label>
        )}
        {selectElement}
        {helperText && (
          <p
            id={helperId}
            className={twMerge('text-sm text-gray-600', hideLabel && 'mt-1')}
          >
            {helperText}
          </p>
        )}
        {error && (
          <p
            id={resolvedErrorId}
            className="mt-1 flex items-start gap-1.5 text-sm font-medium text-red-800"
          >
            <span>{error}</span>
          </p>
        )}
      </div>
    )
  }
)
Select.displayName = 'Select'

export default Select
