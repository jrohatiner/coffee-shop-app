import React from 'react'
export const Tabs = ({value,onValueChange,children}:{value:string;onValueChange:(v:string)=>void;children:React.ReactNode}) => <div>{children}</div>
export const TabsList = ({children}:{children:React.ReactNode}) => <div className="flex gap-2">{children}</div>
export const TabsTrigger = ({value,children,onClick}:{value:string;children:React.ReactNode;onClick?:()=>void}) => (
  <button className="px-2 py-1 border rounded" onClick={onClick}>{children}</button>
)
export const TabsContent = ({children}:{children:React.ReactNode}) => <div>{children}</div>
export default Tabs
