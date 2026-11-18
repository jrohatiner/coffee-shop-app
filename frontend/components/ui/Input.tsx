import React, { useId } from 'react'
import { twMerge } from 'tailwind-merge'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
  error?: string
  errorId?: string
  label?: string
}

export const Input = ({
  className = '',
  error,
  errorId,
  label,
  id,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  placeholder,
  ...props
}: InputProps) => {
  const rawGeneratedId = useId()
  const generatedId = `input-${rawGeneratedId.replace(/:/g, '')}`
  const inputId = id ?? generatedId
  const resolvedErrorId = errorId ?? `${inputId}-error`
  const hasError = Boolean(error) || ariaInvalid === true || ariaInvalid === 'true'
  const describedBy =
    [ariaDescribedBy, error ? resolvedErrorId : undefined].filter(Boolean).join(' ') || undefined
  const hasCustomWidth = /\bw-\S+/.test(className)

  return (
    <div className={hasCustomWidth ? 'inline-block' : 'w-full'}>
      {label && (
        <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-gray-900">
          {label}
        </label>
      )}
      <input
        id={inputId}
        placeholder={placeholder}
        aria-label={ariaLabel ?? (!label && !ariaLabelledBy ? placeholder : undefined)}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={hasError ? 'true' : undefined}
        aria-describedby={describedBy}
        className={twMerge(
          'border rounded px-3 py-2 w-full bg-white text-gray-900 focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-700 ring-1 ring-red-700 focus:ring-red-700'
            : 'border-gray-300 focus:ring-blue-700',
          className
        )}
        {...props}
      />
      {error && (
        <p
          id={resolvedErrorId}
          className="mt-1 flex items-start gap-1.5 text-sm font-medium text-red-800"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="mt-0.5 h-4 w-4 shrink-0 text-red-800"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

export default Input
