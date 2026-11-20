import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'
import { render, fireClick, fireKeyDown } from './test-dom'

type ReportTab = 'daily' | 'weekly' | 'monthly'

const isReportTab = (value: string): value is ReportTab =>
  value === 'daily' || value === 'weekly' || value === 'monthly'

function ControlledReportsTabs({
  initialTab = 'daily',
  onTabChange,
  onDailyClick,
  disableWeekly = false,
}: {
  initialTab?: ReportTab
  onTabChange?: (tab: ReportTab) => void
  onDailyClick?: () => void
  disableWeekly?: boolean
}) {
  const [tab, setTab] = useState<ReportTab>(initialTab)

  const handleChange = (next: string) => {
    if (isReportTab(next)) {
      setTab(next)
      onTabChange?.(next)
    }
  }

  return (
    <Tabs value={tab} onValueChange={handleChange}>
      <TabsList>
        <TabsTrigger value="daily" onClick={onDailyClick}>
          Daily
        </TabsTrigger>
        <TabsTrigger value="weekly" disabled={disableWeekly}>
          Weekly
        </TabsTrigger>
        <TabsTrigger value="monthly">Monthly</TabsTrigger>
      </TabsList>
      <TabsContent value="daily">Daily panel</TabsContent>
      <TabsContent value="weekly">Weekly panel</TabsContent>
      <TabsContent value="monthly">Monthly panel</TabsContent>
    </Tabs>
  )
}

describe('Tabs accessibility and keyboard navigation', () => {
  it('exposes tablist, tab, and tabpanel roles with linked ARIA attributes and roving tabIndex', () => {
    const { container, document } = render(<ControlledReportsTabs />)

    const tablist = container.querySelector('[role="tablist"]')
    assert.ok(tablist, 'renders role="tablist"')

    const tabs = container.querySelectorAll('[role="tab"]')
    assert.equal(tabs.length, 3)

    const panels = container.querySelectorAll('[role="tabpanel"]')
    assert.equal(panels.length, 3)

    // Verify each tab trigger and its matching panel
    const expected = [
      { label: 'Daily', selected: 'true', tabIndex: 0, hidden: false },
      { label: 'Weekly', selected: 'false', tabIndex: -1, hidden: true },
      { label: 'Monthly', selected: 'false', tabIndex: -1, hidden: true },
    ]

    tabs.forEach((tab, index) => {
      const exp = expected[index]
      assert.equal(tab.textContent, exp.label)
      assert.equal(tab.type, 'button')
      assert.equal(tab.getAttribute('type'), 'button')
      assert.equal(tab.getAttribute('aria-selected'), exp.selected)
      assert.equal(tab.tabIndex, exp.tabIndex)
      assert.ok(tab.id, 'tab has non-empty id')

      const controlsId = tab.getAttribute('aria-controls')
      assert.ok(controlsId, 'tab has aria-controls')

      const controlledPanel = document.getElementById(controlsId)
      assert.ok(controlledPanel, 'aria-controls resolves to mounted DOM panel')
      assert.equal(controlledPanel, panels[index])
      assert.equal(controlledPanel.getAttribute('role'), 'tabpanel')
      assert.equal(controlledPanel.tabIndex, 0)
      assert.equal(controlledPanel.getAttribute('aria-labelledby'), tab.id)
      assert.equal(controlledPanel.hidden, exp.hidden)
    })
  })

  it('applies high-contrast active styling to selected tab and updates on click', () => {
    const changes: ReportTab[] = []
    let dailyClicked = 0
    const { container } = render(
      <ControlledReportsTabs
        initialTab="weekly"
        onTabChange={(t) => changes.push(t)}
        onDailyClick={() => {
          dailyClicked += 1
        }}
      />
    )

    const [dailyTab, weeklyTab] = container.querySelectorAll('[role="tab"]')

    for (const cls of [
      'border-2',
      'bg-gray-100',
      'font-semibold',
      'forced-colors:border-[Highlight]',
    ]) {
      assert.ok(
        weeklyTab.className.split(/\s+/).includes(cls),
        `active tab includes ${cls}`
      )
      assert.ok(
        !dailyTab.className.split(/\s+/).includes(cls),
        `inactive tab omits ${cls}`
      )
    }
    assert.ok(dailyTab.className.split(/\s+/).includes('border-control'))
    assert.ok(weeklyTab.className.split(/\s+/).includes('border-control'))

    fireClick(dailyTab)

    assert.deepEqual(changes, ['daily'])
    assert.equal(dailyClicked, 1)
    assert.equal(dailyTab.getAttribute('aria-selected'), 'true')
    assert.equal(weeklyTab.getAttribute('aria-selected'), 'false')
    assert.equal(dailyTab.tabIndex, 0)
    assert.equal(weeklyTab.tabIndex, -1)

    for (const cls of [
      'border-2',
      'bg-gray-100',
      'font-semibold',
      'forced-colors:border-[Highlight]',
    ]) {
      assert.ok(dailyTab.className.split(/\s+/).includes(cls))
      assert.ok(!weeklyTab.className.split(/\s+/).includes(cls))
    }
  })

  it('supports ArrowRight, ArrowLeft, Home, and End with wraparound and focus movement', () => {
    const changes: ReportTab[] = []
    const { container, document } = render(
      <ControlledReportsTabs onTabChange={(t) => changes.push(t)} />
    )

    const [dailyTab, weeklyTab, monthlyTab] =
      container.querySelectorAll('[role="tab"]')
    const [dailyPanel, weeklyPanel, monthlyPanel] =
      container.querySelectorAll('[role="tabpanel"]')

    dailyTab.focus()
    assert.equal(document.activeElement, dailyTab)

    // ArrowRight: Daily -> Weekly
    const right1 = fireKeyDown(dailyTab, { key: 'ArrowRight' })
    assert.equal(right1.defaultPrevented, true)
    assert.equal(document.activeElement, weeklyTab)
    assert.equal(weeklyTab.getAttribute('aria-selected'), 'true')
    assert.equal(weeklyTab.tabIndex, 0)
    assert.equal(dailyTab.tabIndex, -1)
    assert.equal(weeklyPanel.hidden, false)
    assert.equal(dailyPanel.hidden, true)

    // ArrowRight: Weekly -> Monthly
    fireKeyDown(weeklyTab, { key: 'ArrowRight' })
    assert.equal(document.activeElement, monthlyTab)
    assert.equal(monthlyTab.getAttribute('aria-selected'), 'true')
    assert.equal(monthlyPanel.hidden, false)
    assert.equal(weeklyPanel.hidden, true)

    // ArrowRight wraparound: Monthly -> Daily
    fireKeyDown(monthlyTab, { key: 'ArrowRight' })
    assert.equal(document.activeElement, dailyTab)
    assert.equal(dailyTab.getAttribute('aria-selected'), 'true')
    assert.equal(dailyPanel.hidden, false)
    assert.equal(monthlyPanel.hidden, true)

    // ArrowLeft wraparound: Daily -> Monthly
    fireKeyDown(dailyTab, { key: 'ArrowLeft' })
    assert.equal(document.activeElement, monthlyTab)
    assert.equal(monthlyTab.getAttribute('aria-selected'), 'true')

    // ArrowLeft: Monthly -> Weekly
    fireKeyDown(monthlyTab, { key: 'ArrowLeft' })
    assert.equal(document.activeElement, weeklyTab)
    assert.equal(weeklyTab.getAttribute('aria-selected'), 'true')

    // End: Weekly -> Monthly
    const endEvt = fireKeyDown(weeklyTab, { key: 'End' })
    assert.equal(endEvt.defaultPrevented, true)
    assert.equal(document.activeElement, monthlyTab)
    assert.equal(monthlyTab.getAttribute('aria-selected'), 'true')

    // Home: Monthly -> Daily
    const homeEvt = fireKeyDown(monthlyTab, { key: 'Home' })
    assert.equal(homeEvt.defaultPrevented, true)
    assert.equal(document.activeElement, dailyTab)
    assert.equal(dailyTab.getAttribute('aria-selected'), 'true')

    assert.deepEqual(changes, [
      'weekly',
      'monthly',
      'daily',
      'monthly',
      'weekly',
      'monthly',
      'daily',
    ])
  })

  it('skips disabled tabs during keyboard navigation and ignores modifier shortcuts', () => {
    const changes: ReportTab[] = []
    const { container, document } = render(
      <ControlledReportsTabs
        disableWeekly
        onTabChange={(t) => changes.push(t)}
      />
    )

    const [dailyTab, , monthlyTab] = container.querySelectorAll('[role="tab"]')
    dailyTab.focus()

    // Alt+ArrowRight should not be intercepted
    const modEvt = fireKeyDown(dailyTab, { key: 'ArrowRight', altKey: true })
    assert.equal(modEvt.defaultPrevented, false)
    assert.equal(document.activeElement, dailyTab)

    // ArrowRight skips disabled Weekly tab and lands on Monthly
    fireKeyDown(dailyTab, { key: 'ArrowRight' })
    assert.equal(document.activeElement, monthlyTab)
    assert.equal(monthlyTab.getAttribute('aria-selected'), 'true')

    // ArrowRight wraps back to Daily
    fireKeyDown(monthlyTab, { key: 'ArrowRight' })
    assert.equal(document.activeElement, dailyTab)
    assert.deepEqual(changes, ['monthly', 'daily'])
  })

  it('falls back to active context value when TabsContent omits value prop', () => {
    const { container, document } = render(
      <Tabs value="weekly" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
        </TabsList>
        <TabsContent>Shared active content</TabsContent>
      </Tabs>
    )

    const [, weeklyTab] = container.querySelectorAll('[role="tab"]')
    const panel = container.querySelector('[role="tabpanel"]')
    assert.ok(panel)
    assert.equal(panel.hidden, false)
    assert.equal(panel.id, weeklyTab.getAttribute('aria-controls'))
    assert.equal(panel.getAttribute('aria-labelledby'), weeklyTab.id)
    assert.equal(document.getElementById(panel.id), panel)
  })

  it('throws a clear error when TabsList, TabsTrigger, or TabsContent renders outside Tabs', () => {
    const origError = console.error
    console.error = () => {}
    try {
      assert.throws(
        () => render(<TabsList>orphan</TabsList>),
        /TabsList must be used within a Tabs component/
      )
      assert.throws(
        () => render(<TabsTrigger value="daily">Daily</TabsTrigger>),
        /TabsTrigger must be used within a Tabs component/
      )
      assert.throws(
        () => render(<TabsContent value="daily">Content</TabsContent>),
        /TabsContent must be used within a Tabs component/
      )
    } finally {
      console.error = origError
    }
  })

  it('generates distinct non-colliding IDs across multiple Tabs instances', () => {
    const { container } = render(
      <div>
        <Tabs value="a" onValueChange={() => {}}>
          <TabsList>
            <TabsTrigger value="a">First A</TabsTrigger>
          </TabsList>
          <TabsContent value="a">Panel 1</TabsContent>
        </Tabs>
        <Tabs value="a" onValueChange={() => {}}>
          <TabsList>
            <TabsTrigger value="a">Second A</TabsTrigger>
          </TabsList>
          <TabsContent value="a">Panel 2</TabsContent>
        </Tabs>
      </div>
    )

    const tabs = container.querySelectorAll('[role="tab"]')
    const panels = container.querySelectorAll('[role="tabpanel"]')
    assert.equal(tabs.length, 2)
    assert.equal(panels.length, 2)
    assert.notEqual(tabs[0].id, tabs[1].id)
    assert.notEqual(panels[0].id, panels[1].id)
    assert.equal(tabs[0].getAttribute('aria-controls'), panels[0].id)
    assert.equal(tabs[1].getAttribute('aria-controls'), panels[1].id)
  })
})
