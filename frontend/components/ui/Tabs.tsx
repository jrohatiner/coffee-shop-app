import React from 'react'

type TabsContextValue = {
  value: string
  onValueChange: (value: string) => void
  baseId: string
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

const useTabsContext = (componentName: string): TabsContextValue => {
  const context = React.useContext(TabsContext)
  if (!context) {
    throw new Error(`${componentName} must be used within a Tabs component`)
  }
  return context
}

const formatIdSegment = (segment: string): string =>
  segment.replace(/[^a-zA-Z0-9_-]/g, (ch) => `_${ch.charCodeAt(0)}_`)

const getTriggerId = (baseId: string, tabValue: string): string =>
  `${baseId}-tab-${formatIdSegment(tabValue)}`

const getPanelId = (baseId: string, tabValue: string): string =>
  `${baseId}-tabpanel-${formatIdSegment(tabValue)}`

export type TabsProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onChange'
> & {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
}

export const Tabs = ({
  value,
  onValueChange,
  children,
  ...props
}: TabsProps) => {
  const reactId = React.useId()
  const baseId = `tabs-${reactId.replace(/:/g, '')}`

  const contextValue = React.useMemo<TabsContextValue>(
    () => ({
      value,
      onValueChange,
      baseId,
    }),
    [value, onValueChange, baseId]
  )

  return (
    <TabsContext.Provider value={contextValue}>
      <div {...props}>{children}</div>
    </TabsContext.Provider>
  )
}

export type TabsListProps = React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode
}

export const TabsList = ({
  children,
  className = '',
  onKeyDown,
  ...props
}: TabsListProps) => {
  const { onValueChange } = useTabsContext('TabsList')

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (
      e.key !== 'ArrowRight' &&
      e.key !== 'ArrowLeft' &&
      e.key !== 'Home' &&
      e.key !== 'End'
    ) {
      return
    }

    const tablist = e.currentTarget
    const enabledTabs = Array.from(
      tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')
    ).filter(
      (tab) =>
        tab.getAttribute('aria-disabled') !== 'true' &&
        (!tab.closest || tab.closest('[role="tablist"]') === tablist)
    )

    if (enabledTabs.length === 0) return

    const targetTab = (e.target as HTMLElement | null)?.closest?.(
      '[role="tab"]'
    ) as HTMLButtonElement | null
    const activeElement = tablist.ownerDocument?.activeElement as
      | HTMLButtonElement
      | null
      | undefined

    let currentIndex = targetTab ? enabledTabs.indexOf(targetTab) : -1
    if (currentIndex === -1 && activeElement) {
      currentIndex = enabledTabs.indexOf(activeElement)
    }
    if (currentIndex === -1) {
      currentIndex = enabledTabs.findIndex(
        (tab) => tab.getAttribute('aria-selected') === 'true'
      )
    }
    if (currentIndex === -1) {
      currentIndex = 0
    }

    let nextIndex = currentIndex
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % enabledTabs.length
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = enabledTabs.length - 1
    }

    e.preventDefault()
    const nextTab = enabledTabs[nextIndex]
    nextTab.focus()
    const nextValue = nextTab.getAttribute('data-value')
    if (nextValue !== null) {
      onValueChange(nextValue)
    }
  }

  const classes = ['flex gap-2', className].filter(Boolean).join(' ')

  return (
    <div {...props} role="tablist" className={classes} onKeyDown={handleKeyDown}>
      {children}
    </div>
  )
}

export type TabsTriggerProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'value'
> & {
  value: string
  children: React.ReactNode
}

export const TabsTrigger = ({
  value,
  children,
  className = '',
  onClick,
  disabled,
  id,
  ...props
}: TabsTriggerProps) => {
  const { value: selectedValue, onValueChange, baseId } =
    useTabsContext('TabsTrigger')
  const isSelected = selectedValue === value
  const triggerId = id ?? getTriggerId(baseId, value)
  const panelId = getPanelId(baseId, value)

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return
    onValueChange(value)
    onClick?.(e)
  }

  const baseClasses =
    'px-2 py-1 border rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-50 disabled:cursor-not-allowed'
  const stateClasses = isSelected
    ? 'bg-gray-900 text-white font-semibold border-gray-900'
    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
  const classes = [baseClasses, stateClasses, className].filter(Boolean).join(' ')

  return (
    <button
      {...props}
      type="button"
      role="tab"
      id={triggerId}
      aria-selected={isSelected}
      aria-controls={panelId}
      tabIndex={isSelected && !disabled ? 0 : -1}
      data-value={value}
      disabled={disabled}
      className={classes}
      onClick={handleClick}
    >
      {children}
    </button>
  )
}

export type TabsContentProps = React.HTMLAttributes<HTMLDivElement> & {
  value?: string
  children: React.ReactNode
}

export const TabsContent = ({
  value,
  children,
  id,
  ...props
}: TabsContentProps) => {
  const { value: selectedValue, baseId } = useTabsContext('TabsContent')
  const resolvedValue = value ?? selectedValue
  const isSelected = resolvedValue === selectedValue
  const panelId = id ?? getPanelId(baseId, resolvedValue)
  const triggerId = getTriggerId(baseId, resolvedValue)

  return (
    <div
      {...props}
      role="tabpanel"
      id={panelId}
      tabIndex={0}
      aria-labelledby={triggerId}
      hidden={!isSelected}
    >
      {children}
    </div>
  )
}

export default Tabs
