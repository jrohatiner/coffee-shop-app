import React from 'react'

export type FormErrorBannerProps = {
  id?: string
  message?: string | null
  className?: string
  children?: React.ReactNode
}

export const FormErrorBanner = ({
  id,
  message,
  className = '',
  children,
}: FormErrorBannerProps) => {
  const content = children ?? message
  if (!content) return null

  return (
    <div
      id={id}
      role="alert"
      className={`rounded border border-red-700 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 ${className}`.trim()}
    >
      {content}
    </div>
  )
}

export default FormErrorBanner
