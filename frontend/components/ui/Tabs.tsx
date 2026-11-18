import React from 'react'
import { twMerge } from 'tailwind-merge'

type TabsContextValue = {
  value: string
  onValueChange?: (v: string) => void
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

export const Tabs = ({
  value,
  onValueChange,
  children,
  className,
  ...props
}: {
  value: string
  onValueChange?: (v: string) => void
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>) => (
  <TabsContext.Provider value={{ value, onValueChange }}>
    <div className={className} {...props}>
      {children}
    </div>
  </TabsContext.Provider>
)

export const TabsList = ({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div role="tablist" className={twMerge('flex gap-2', className)} {...props}>
    {children}
  </div>
)

export const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }
>(({ value, children, className, onClick, type = 'button', ...props }, ref) => {
  const ctx = React.useContext(TabsContext)
  const isSelected = ctx ? ctx.value === value : false

  return (
    <button
      ref={ref}
      type={type}
      role="tab"
      aria-selected={isSelected}
      data-state={isSelected ? 'active' : 'inactive'}
      className={twMerge(
        'px-2 py-1 border border-control rounded bg-white text-gray-900 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600',
        isSelected && 'border-2 bg-gray-100 font-semibold forced-colors:border-[Highlight]',
        className
      )}
      onClick={(e) => {
        ctx?.onValueChange?.(value)
        onClick?.(e)
      }}
      {...props}
    >
      {children}
    </button>
  )
})
TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = ({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div role="tabpanel" className={className} {...props}>
    {children}
  </div>
)

export default Tabs
