import React from 'react'
export const Button = ({children, className='', ...props}: React.ButtonHTMLAttributes<HTMLButtonElement> & {className?:string}) => (
  <button className={`px-3 py-2 border rounded hover:bg-gray-100 ${className}`} {...props}>{children}</button>
)
export default Button
