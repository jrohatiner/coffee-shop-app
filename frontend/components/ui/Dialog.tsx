import React from 'react'
export const Dialog = ({open, onOpenChange, children}:{open:boolean;onOpenChange:()=>void;children:React.ReactNode}) => {
  if(!open) return null
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={onOpenChange}>
      <div className="bg-white rounded shadow p-4 min-w-[320px]" onClick={(e)=>e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
export default Dialog
