import React from 'react'
export const Input = ({className='', ...props}: React.InputHTMLAttributes<HTMLInputElement> & {className?:string}) => (
  <input className={`border rounded px-3 py-2 w-full ${className}`} {...props} />
)
export default Input
