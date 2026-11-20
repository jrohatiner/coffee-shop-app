import { expect, Page, test } from '@playwright/test'

function createMockJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'manager@coffeeshop.example',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url')
  return `${header}.${payload}.mock-signature`
}

async function authenticatePage(page: Page) {
  const token = createMockJwt()
  await page.addInitScript((jwt) => {
    window.localStorage.setItem('token', jwt)
  }, token)

  await page.route('**/ws/**', async (route) => {
    await route.abort()
  })
}

test.describe('Unified live-region toasts and async route banners', () => {
  test('mounts persistent dual live regions on /login, preserves focus on destructive toast, and pauses 10s timer on hover/focus', async ({
    page,
  }) => {
    await page.clock.install()

    await page.route('http://localhost:8000/auth/token', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Invalid credentials' }),
      })
    })

    await page.goto('/login')

    const assertiveRegion = page.getByTestId('toast-live-assertive')
    const politeRegion = page.getByTestId('toast-live-polite')
    await expect(assertiveRegion).toHaveAttribute('role', 'alert')
    await expect(assertiveRegion).toHaveAttribute('aria-live', 'assertive')
    await expect(politeRegion).toHaveAttribute('role', 'status')
    await expect(politeRegion).toHaveAttribute('aria-live', 'polite')

    const signInButton = page.getByRole('button', { name: 'Sign in' })
    await signInButton.focus()
    await signInButton.click()

    const toastCard = assertiveRegion.locator('[data-toast-variant="destructive"]')
    await expect(toastCard).toBeVisible()
    await expect(toastCard).toContainText('Login failed')
    await expect(toastCard).toContainText('Invalid credentials')
    await expect(toastCard).toHaveClass(/\bborder-control\b/)
    await expect(toastCard.getByRole('button', { name: 'Dismiss Login failed notification' })).toHaveClass(
      /\bborder-control\b/
    )

    // Keyboard focus must NOT move automatically when toast appears (WCAG 4.1.3)
    await expect(signInButton).toBeFocused()

    // Destructive toast stays visible past 5000ms (10000ms total)
    await page.clock.fastForward(6000)
    await expect(toastCard).toBeVisible()

    // Hovering pauses the remaining ~4000ms countdown indefinitely
    await toastCard.hover()
    await page.clock.fastForward(15000)
    await expect(toastCard).toBeVisible()

    // Moving mouse away resumes the remaining countdown
    await page.mouse.move(0, 0)
    await page.clock.fastForward(4500)
    await expect(toastCard).toHaveCount(0)
  })

  test('Dashboard announces loading via role="status" and renders FormErrorBanner instead of $0.00 on failure', async ({
    page,
  }) => {
    await authenticatePage(page)

    let releaseFailure!: () => void
    const holdRequest = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })

    await page.route('http://localhost:8000/dashboard/summary', async (route) => {
      await holdRequest
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Summary service unavailable' }),
      })
    })

    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
    await expect(page.locator('main [role="status"]')).toContainText('Loading dashboard summary...')
    await expect(page.locator('main')).not.toContainText('$0')

    releaseFailure()

    const banner = page.locator('main [role="alert"]')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveText('Summary service unavailable')
    await expect(page.locator('main')).not.toContainText('$0')
  })

  test('Reports clears prior rows immediately on tab switch, announces status, and renders FormErrorBanner on error', async ({
    page,
  }) => {
    await authenticatePage(page)

    let releaseWeekly!: () => void
    const holdWeekly = new Promise<void>((resolve) => {
      releaseWeekly = resolve
    })

    await page.route('http://localhost:8000/reports/daily', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, report_type: 'daily', total_sales: 240.75 }]),
      })
    })

    await page.route('http://localhost:8000/reports/weekly', async (route) => {
      await holdWeekly
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Weekly aggregation failed' }),
      })
    })

    await page.route('http://localhost:8000/reports/monthly', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto('/reports')
    await expect(page.locator('main')).toContainText('$240.75')

    const weeklyTab = page.getByRole('tab', { name: 'Weekly' })
    await weeklyTab.focus()
    await weeklyTab.click()

    // Prior daily row clears immediately and status announces loading while focus stays on Weekly tab
    await expect(page.locator('main')).not.toContainText('$240.75')
    await expect(page.locator('main [role="status"]')).toContainText('Loading weekly sales reports...')
    await expect(weeklyTab).toBeFocused()

    releaseWeekly()

    const errorBanner = page.locator('main [role="alert"]')
    await expect(errorBanner).toBeVisible()
    await expect(errorBanner).toHaveText('Weekly aggregation failed')
    await expect(weeklyTab).toBeFocused()

    // Switching to Monthly announces empty status
    const monthlyTab = page.getByRole('tab', { name: 'Monthly' })
    await monthlyTab.click()
    await expect(page.locator('main [role="status"]')).toContainText('No monthly sales reports available.')
  })

  test('Orders and Inventory expose role="status" counts/empty states and render FormErrorBanner when /inventory fails', async ({
    page,
  }) => {
    await authenticatePage(page)

    await page.route('http://localhost:8000/inventory', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Inventory database unreachable' }),
      })
    })

    await page.route('http://localhost:8000/orders*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'x-has-more': 'false' },
        body: JSON.stringify([]),
      })
    })

    await page.goto('/orders')
    await expect(page.locator('main [role="alert"]')).toHaveText('Inventory database unreachable')
    await expect(page.locator('main [role="status"]', { hasText: 'No orders found.' })).toBeVisible()
    await expect(
      page.locator('main [role="status"]', { hasText: 'Page 1 · Showing 0 orders' })
    ).toBeVisible()

    await page.goto('/inventory')
    await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible()
    await expect(page.locator('main [role="alert"]')).toHaveText('Inventory database unreachable')
  })
})
