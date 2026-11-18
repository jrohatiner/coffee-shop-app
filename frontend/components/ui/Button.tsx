import React from 'react'

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  className?: string
  contextLabel?: string
}

export const Button = ({
  children,
  className = '',
  contextLabel,
  ...props
}: ButtonProps) => {
  const trimmedContext = contextLabel?.trim()
  return (
    <button
      className={`px-3 py-2 border rounded hover:bg-gray-100 ${className}`.trim()}
      {...props}
    >
      {children}
      {trimmedContext ? <span className="sr-only">{` ${trimmedContext}`}</span> : null}
    </button>
  )
}

export default Button
