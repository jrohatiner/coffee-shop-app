import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Select from '../components/ui/Select'
import { clearToasts } from '../components/ui/use-toast'

const routerModule = require('next/router')
const socketIoModule = require('socket.io-client')

let pushedRoutes: string[] = []
const fakeRouter = {
  pathname: '/login',
  push: (url: string) => {
    pushedRoutes.push(url)
    return Promise.resolve(true)
  },
}

routerModule.useRouter = () => fakeRouter
socketIoModule.io = () => ({
  on: () => {},
  disconnect: () => {},
})

import Login from '../pages/login'
import Inventory, { ProductRow } from '../pages/inventory'
import Orders, { ProductOrderRow, ProductPickerRow } from '../pages/orders'
import Users from '../pages/users'

function makeValidJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ sub: 'manager@coffee.test', exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

function createMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, val: string) => {
      store.set(key, String(val))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

function getText(node: ReactTestInstance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : getText(child)))
    .join('')
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

function assertUniqueControlIdsAndLabels(root: ReactTestInstance) {
  const controls = [
    ...root.findAllByType('input'),
    ...root.findAllByType('select'),
  ]
  assert.ok(controls.length > 0, 'Expected at least one form control')

  const labels = root.findAllByType('label')
  const seenControlIds = new Set<string>()

  for (const control of controls) {
    const id = control.props.id
    assert.equal(typeof id, 'string', 'Every input/select must have a string id')
    assert.ok(id.trim().length > 0, 'Every input/select id must be non-empty')
    assert.equal(seenControlIds.has(id), false, `Duplicate control id "${id}"`)
    seenControlIds.add(id)

    const matchingLabel = labels.find(lbl => lbl.props.htmlFor === id)
    assert.ok(matchingLabel, `Expected <label htmlFor="${id}"> for control`)
    assert.ok(getText(matchingLabel).trim().length > 0, `Expected non-empty label text for "${id}"`)
  }
}

describe('Input and Select accessible primitives', () => {
  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  })

  it('forwards refs, generates unique useId fallbacks, supports hideLabel, and links helperText + error via aria-describedby', () => {
    let capturedNode: unknown = null
    const refCallback = (node: HTMLInputElement | null) => {
      capturedNode = node
    }

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <div>
          <Input
            ref={refCallback}
            label="Barista Pin"
            helperText="Enter 4 digits"
            error="Pin must be 4 digits."
            aria-describedby="external-hint"
          />
          <Input label="Compact Row Qty" hideLabel />
          <Select label="Roast Level" hideLabel helperText="Choose roast" error="Required">
            <option value="light">Light</option>
          </Select>
        </div>,
        {
          createNodeMock: element => ({ tagName: element.type, props: element.props }),
        }
      )
    })

    assert.ok(capturedNode, 'Expected Input React.forwardRef to receive input element')
    const [firstInput, secondInput] = renderer.root.findAllByType('input')
    assert.notEqual(firstInput.props.id, secondInput.props.id)

    const labels = renderer.root.findAllByType('label')
    assert.equal(labels[0].props.htmlFor, firstInput.props.id)
    assert.equal(labels[0].props.className.includes('sr-only'), false)
    assert.equal(labels[1].props.htmlFor, secondInput.props.id)
    assert.equal(labels[1].props.className.includes('sr-only'), true)

    assert.equal(firstInput.props['aria-invalid'], 'true')
    const describedByTokens = String(firstInput.props['aria-describedby']).split(' ')
    assert.deepEqual(describedByTokens, [
      'external-hint',
      `${firstInput.props.id}-helper`,
      `${firstInput.props.id}-error`,
    ])

    const errorPara = renderer.root.findByProps({ id: `${firstInput.props.id}-error` })
    assert.equal(errorPara.props.role, undefined, 'Field error should not add duplicate role="alert"')
    assert.match(getText(errorPara), /Pin must be 4 digits\./)

    const selectEl = renderer.root.findByType('select')
    assert.equal(selectEl.props['aria-invalid'], 'true')
    assert.equal(labels[2].props.htmlFor, selectEl.props.id)
    assert.equal(labels[2].props.className.includes('sr-only'), true)

    renderer.unmount()
  })
})

describe('Reconciled page forms accessibility and error handling', () => {
  const originalApiGet = api.get
  const originalApiPost = api.post

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    clearToasts()
    pushedRoutes = []
    const storage = createMemoryStorage()
    storage.setItem('token', makeValidJwt())
    ;(globalThis as any).localStorage = storage
  })

  afterEach(() => {
    api.get = originalApiGet
    api.post = originalApiPost
  })

  it('reconciles /login into one form with persistent labels, field errors, and FormErrorBanner on rejected credentials', async () => {
    let postCalls = 0
    api.post = (async () => {
      postCalls += 1
      throw new Error('Unauthorized')
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Login />)
    })

    assert.equal(renderer.root.findAllByType('form').length, 1)
    assertUniqueControlIdsAndLabels(renderer.root)

    // Submitting empty fields surfaces field-level errors without rendering duplicate alert banner
    const form = renderer.root.findByType('form')
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} })
    })
    assert.equal(postCalls, 1)
    assert.equal(renderer.root.findAll(n => n.props?.role === 'alert').length, 0)

    let [userInput, passInput] = renderer.root.findAllByType('input')
    assert.equal(userInput.props['aria-invalid'], 'true')
    assert.equal(passInput.props['aria-invalid'], 'true')
    assert.ok(renderer.root.findByProps({ id: userInput.props['aria-describedby'] }))
    assert.ok(renderer.root.findByProps({ id: passInput.props['aria-describedby'] }))

    // Typing credentials clears field errors; rejected API submission announces FormErrorBanner
    await act(async () => {
      userInput.props.onChange({ target: { value: 'barista' } })
      passInput.props.onChange({ target: { value: 'wrong-secret' } })
    })
    ;[userInput, passInput] = renderer.root.findAllByType('input')
    assert.equal(userInput.props['aria-invalid'], undefined)
    assert.equal(passInput.props['aria-invalid'], undefined)

    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} })
    })
    assert.equal(postCalls, 2)

    const banner = renderer.root.find(n => n.type === 'div' && n.props.id === 'login-form-error')
    assert.equal(banner.props.role, 'alert')
    ;[userInput, passInput] = renderer.root.findAllByType('input')
    assert.equal(userInput.props['aria-invalid'], 'true')
    assert.equal(userInput.props['aria-describedby'], 'login-form-error')
    assert.equal(passInput.props['aria-invalid'], 'true')
    assert.equal(passInput.props['aria-describedby'], 'login-form-error')

    renderer.unmount()
  })

  it('reconciles /inventory with unique IDs across CreateProductForm and ProductRow items plus field/banner errors', async () => {
    api.get = (async () => ({
      data: [
        { id: 1, name: 'Espresso', price: 3.0, stock: 10 },
        { id: 2, name: 'Cortado', price: 4.0, stock: 12 },
      ],
    })) as any
    api.post = (async () => {
      const err: any = new Error('Conflict')
      err.response = { data: { detail: 'Product already exists' } }
      throw err
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Inventory />)
      await flushPromises()
    })

    assertUniqueControlIdsAndLabels(renderer.root)
    assert.equal(renderer.root.findAllByType(ProductRow.type ?? ProductRow).length, 2)

    // Empty product name sets aria-invalid + aria-describedby on CreateProductForm Name input
    const addBtn = renderer.root.findAllByType('button').find(b => getText(b).trim() === 'Add Product')!
    await act(async () => {
      await addBtn.props.onClick()
    })
    const createNameInput = renderer.root.findAllByType('input')[0]
    assert.equal(createNameInput.props['aria-invalid'], 'true')
    assert.ok(renderer.root.findByProps({ id: createNameInput.props['aria-describedby'] }))

    // API failure displays FormErrorBanner
    await act(async () => {
      createNameInput.props.onChange({ target: { value: 'Espresso' } })
    })
    await act(async () => {
      await addBtn.props.onClick()
    })
    const alerts = renderer.root.findAll(n => n.type === 'div' && n.props?.role === 'alert')
    assert.equal(alerts.length, 1)
    assert.match(getText(alerts[0]), /Product already exists/)

    renderer.unmount()
  })

  it('reconciles /orders with ProductOrderRow unique IDs, Select controls, and FormErrorBanner', async () => {
    assert.equal(ProductOrderRow, ProductPickerRow)
    api.get = (async (url: string) => {
      if (url === '/inventory') {
        return {
          data: [
            { id: 1, name: 'Espresso', price: 3.0, stock: 10 },
            { id: 2, name: 'Latte', price: 4.5, stock: 8 },
          ],
        } as any
      }
      return { data: [] } as any
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Orders />)
      await flushPromises()
    })

    assertUniqueControlIdsAndLabels(renderer.root)
    assert.equal(renderer.root.findAllByType('select').length, 3)

    // Submitting empty cart shows FormErrorBanner; adding qty > 0 clears it
    const createOrderBtn = renderer.root
      .findAllByType('button')
      .find(b => getText(b).trim() === 'Create Order')!
    await act(async () => {
      await createOrderBtn.props.onClick()
    })

    const errorBanner = renderer.root.find(
      n => n.type === 'div' && n.props.id === 'orders-form-error'
    )
    assert.equal(errorBanner.props.role, 'alert')

    const firstQtyInput = renderer.root.findAll(
      n => n.type === 'input' && n.props.type === 'number'
    )[0]
    await act(async () => {
      firstQtyInput.props.onChange({ target: { value: '2' } })
    })
    assert.equal(renderer.root.findAll(n => n.props?.id === 'orders-form-error' && n.type === 'div').length, 0)

    renderer.unmount()
  })

  it('reconciles /users into one Users export with unique existing-users-heading, checkbox id, field errors, and FormErrorBanner', async () => {
    api.get = (async () => ({
      data: [
        { id: 1, username: 'admin', is_manager: true },
        { id: 2, username: 'barista', is_manager: false },
      ],
    })) as any
    api.post = (async () => {
      const err: any = new Error('Duplicate')
      err.response = { data: { detail: 'Username taken' } }
      throw err
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Users />)
      await flushPromises()
    })

    assertUniqueControlIdsAndLabels(renderer.root)
    const headings = renderer.root.findAll(
      n => n.type === 'h2' && n.props.id === 'existing-users-heading'
    )
    assert.equal(headings.length, 1)

    const createUserBtn = renderer.root
      .findAllByType('button')
      .find(b => getText(b).trim() === 'Create User')!
    await act(async () => {
      await createUserBtn.props.onClick()
    })

    let [uInput, pInput] = renderer.root.findAllByType('input')
    assert.equal(uInput.props['aria-invalid'], 'true')
    assert.equal(pInput.props['aria-invalid'], 'true')

    await act(async () => {
      uInput.props.onChange({ target: { value: 'admin' } })
      pInput.props.onChange({ target: { value: 'pass123' } })
    })
    await act(async () => {
      await createUserBtn.props.onClick()
    })

    const createBanner = renderer.root.find(
      n => n.type === 'div' && n.props.id === 'users-create-error'
    )
    assert.equal(createBanner.props.role, 'alert')
    assert.match(getText(createBanner), /Username taken/)

    renderer.unmount()
  })
})
