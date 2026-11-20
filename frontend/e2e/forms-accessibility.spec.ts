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

async function assertEveryControlHasUniqueIdAndAccessibleName(page: Page) {
  const report = await page.evaluate(() => {
    const allIds = Array.from(document.querySelectorAll('[id]')).map(el => el.id)
    const duplicateIds = allIds.filter((id, idx) => id && allIds.indexOf(id) !== idx)

    const controls = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')
    )
    const details = controls.map(ctrl => {
      const id = ctrl.id
      const explicitLabels = Array.from(ctrl.labels ?? [])
        .map(l => l.textContent?.trim() ?? '')
        .filter(Boolean)
      const labelledByIds = (ctrl.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
      const labelledByText = labelledByIds
        .map(refId => document.getElementById(refId)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
      const ariaLabel = ctrl.getAttribute('aria-label')?.trim() ?? ''
      const accessibleName = labelledByText || explicitLabels.join(' ') || ariaLabel
      return {
        tag: ctrl.tagName.toLowerCase(),
        type: ctrl instanceof HTMLInputElement ? ctrl.type : 'select-one',
        id,
        hasLabelElement: explicitLabels.length > 0,
        accessibleName,
      }
    })

    return { duplicateIds, details }
  })

  expect(report.duplicateIds).toEqual([])
  expect(report.details.length).toBeGreaterThan(0)
  for (const item of report.details) {
    expect(item.id.trim().length).toBeGreaterThan(0)
    expect(item.hasLabelElement).toBe(true)
    expect(item.accessibleName.length).toBeGreaterThan(0)
  }
}

test.describe('Unified Input and form accessibility across staff workflows', () => {
  test('/login exposes persistent labels, field errors, and FormErrorBanner on rejected credentials', async ({
    page,
  }) => {
    await page.route(
      url => url.origin === 'http://localhost:8000' && url.pathname === '/auth/token',
      async route => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Incorrect username or password' }),
        })
      }
    )

    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Login', level: 1 })).toBeVisible()
    await assertEveryControlHasUniqueIdAndAccessibleName(page)

    const usernameField = page.getByLabel('Username')
    const passwordField = page.getByLabel('Password')

    // Empty submission marks fields invalid with aria-describedby error text
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(usernameField).toHaveAttribute('aria-invalid', 'true')
    await expect(passwordField).toHaveAttribute('aria-invalid', 'true')

    // Rejected credentials announce FormErrorBanner via role="alert" and aria-describedby
    await usernameField.fill('staff')
    await passwordField.fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const banner = page.locator('#login-form-error')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('role', 'alert')
    await expect(usernameField).toHaveAttribute('aria-invalid', 'true')
    await expect(passwordField).toHaveAttribute('aria-invalid', 'true')
    await expect(passwordField).toHaveAttribute('aria-describedby', 'login-form-error')
  })

  test('/inventory, /orders, and /users expose unique control IDs, persistent labels, and accessible error states', async ({
    page,
  }) => {
    const token = createMockJwt()
    await page.addInitScript(jwt => {
      window.localStorage.setItem('token', jwt)
    }, token)

    await page.route('**/ws/**', route => route.abort())
    await page.route(
      url => url.origin === 'http://localhost:8000' && url.pathname === '/inventory',
      async route => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Product name already exists' }),
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 1, name: 'Espresso', price: 3.5, stock: 25 },
            { id: 2, name: 'Flat White', price: 4.5, stock: 18 },
          ]),
        })
      }
    )
    await page.route(
      url => url.origin === 'http://localhost:8000' && url.pathname === '/orders',
      async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'x-has-more': 'false' },
          body: JSON.stringify([
            { id: 101, status: 'pending', created_at: '2026-11-18T09:15:00.000Z', items: [] },
          ]),
        })
      }
    )
    await page.route(
      url => url.origin === 'http://localhost:8000' && url.pathname === '/users',
      async route => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Username already registered' }),
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 1, username: 'alice', is_manager: true },
            { id: 2, username: 'bob', is_manager: false },
          ]),
        })
      }
    )

    // /inventory
    await page.goto('/inventory')
    await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible()
    await expect(page.locator('fieldset')).toHaveCount(2)
    await assertEveryControlHasUniqueIdAndAccessibleName(page)
    await page.getByRole('button', { name: 'Add Product' }).click()
    await expect(page.getByPlaceholder('e.g. Flat White')).toHaveAttribute('aria-invalid', 'true')

    // /orders
    await page.goto('/orders')
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible()
    await expect(page.getByLabel('Order Status')).toBeVisible()
    await assertEveryControlHasUniqueIdAndAccessibleName(page)
    await page.getByRole('button', { name: 'Create Order' }).click()
    await expect(page.locator('#orders-form-error')).toBeVisible()

    // /users
    await page.goto('/users')
    await expect(page.getByRole('heading', { name: 'User Management', level: 1 })).toBeVisible()
    await expect(page.locator('#existing-users-heading')).toHaveCount(1)
    await assertEveryControlHasUniqueIdAndAccessibleName(page)
    await page.getByRole('button', { name: 'Create User' }).click()
    await expect(page.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true')
  })
})
