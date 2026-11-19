import React from 'react'
import { createRequire } from 'node:module'

const requireModule = createRequire(__filename)
const { createRoot } = requireModule('react-dom/client')
const { act } = requireModule('react-dom/test-utils')

export type EventInitDict = {
  bubbles?: boolean
  cancelable?: boolean
  key?: string
  code?: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  button?: number
  buttons?: number
}

export class TestEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  target: TestNode | null = null
  srcElement: TestNode | null = null
  currentTarget: TestNode | null = null
  eventPhase = 0
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  button: number
  buttons: number
  view: unknown = null
  _stopped = false
  _immediateStopped = false

  constructor(type: string, init: EventInitDict = {}) {
    this.type = type
    this.bubbles = init.bubbles ?? true
    this.cancelable = init.cancelable ?? true
    this.key = init.key ?? ''
    this.code = init.code ?? init.key ?? ''
    this.altKey = init.altKey ?? false
    this.ctrlKey = init.ctrlKey ?? false
    this.metaKey = init.metaKey ?? false
    this.shiftKey = init.shiftKey ?? false
    this.button = init.button ?? 0
    this.buttons = init.buttons ?? 0
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true
    }
  }

  stopPropagation() {
    this._stopped = true
  }

  stopImmediatePropagation() {
    this._stopped = true
    this._immediateStopped = true
  }

  getModifierState(key: string): boolean {
    if (key === 'Alt') return this.altKey
    if (key === 'Control') return this.ctrlKey
    if (key === 'Meta') return this.metaKey
    if (key === 'Shift') return this.shiftKey
    return false
  }
}

type Listener = (event: TestEvent) => void

const isCaptureOption = (options?: boolean | { capture?: boolean }): boolean =>
  typeof options === 'boolean' ? options : Boolean(options?.capture)

export class TestNode {
  nodeType: number
  nodeName: string
  ownerDocument: TestDocument
  childNodes: TestNode[] = []
  parentNode: TestNode | null = null
  private captureListeners = new Map<string, Set<Listener>>()
  private bubbleListeners = new Map<string, Set<Listener>>()

  constructor(nodeType: number, nodeName: string, ownerDocument?: TestDocument) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument ?? (this as unknown as TestDocument)
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): TestNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null
    const idx = this.parentNode.childNodes.indexOf(this)
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] ?? null : null
  }

  get previousSibling(): TestNode | null {
    if (!this.parentNode) return null
    const idx = this.parentNode.childNodes.indexOf(this)
    return idx > 0 ? this.parentNode.childNodes[idx - 1] ?? null : null
  }

  get parentElement(): TestElement | null {
    return this.parentNode && this.parentNode.nodeType === 1
      ? (this.parentNode as TestElement)
      : null
  }

  appendChild<T extends TestNode>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child)
    }
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild<T extends TestNode>(child: T): T {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) {
      this.childNodes.splice(idx, 1)
      child.parentNode = null
    }
    return child
  }

  insertBefore<T extends TestNode>(child: T, referenceNode: TestNode | null): T {
    if (!referenceNode) {
      return this.appendChild(child)
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child)
    }
    const idx = this.childNodes.indexOf(referenceNode)
    child.parentNode = this
    if (idx >= 0) {
      this.childNodes.splice(idx, 0, child)
    } else {
      this.childNodes.push(child)
    }
    return child
  }

  contains(other: TestNode | null): boolean {
    let cur: TestNode | null = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }

  addEventListener(
    type: string,
    listener: Listener,
    options?: boolean | { capture?: boolean }
  ) {
    const map = isCaptureOption(options)
      ? this.captureListeners
      : this.bubbleListeners
    if (!map.has(type)) {
      map.set(type, new Set())
    }
    map.get(type)!.add(listener)
  }

  removeEventListener(
    type: string,
    listener: Listener,
    options?: boolean | { capture?: boolean }
  ) {
    const map = isCaptureOption(options)
      ? this.captureListeners
      : this.bubbleListeners
    map.get(type)?.delete(listener)
  }

  dispatchEvent(event: TestEvent): boolean {
    event.target = this
    event.srcElement = this
    event.view = this.ownerDocument.defaultView

    const path: TestNode[] = []
    let cur: TestNode | null = this
    while (cur) {
      path.push(cur)
      cur = cur.parentNode
    }

    // Capture phase (ancestors top-down to target)
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i]
      event.currentTarget = node
      event.eventPhase = node === this ? 2 : 1
      const listeners = [...(node.captureListeners.get(event.type) ?? [])]
      for (const listener of listeners) {
        listener.call(node, event)
        if (event._immediateStopped) break
      }
      if (event._stopped) break
    }

    // Bubble phase (target up to ancestors)
    if (!event._stopped) {
      const maxIndex = event.bubbles ? path.length : 1
      for (let i = 0; i < maxIndex; i++) {
        const node = path[i]
        event.currentTarget = node
        event.eventPhase = node === this ? 2 : 3
        const listeners = [...(node.bubbleListeners.get(event.type) ?? [])]
        for (const listener of listeners) {
          listener.call(node, event)
          if (event._immediateStopped) break
        }
        if (event._stopped) break
      }
    }

    event.currentTarget = null
    event.eventPhase = 0
    return !event.defaultPrevented
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes.forEach((c) => {
      c.parentNode = null
    })
    this.childNodes = []
    if (value !== '') {
      this.appendChild(this.ownerDocument.createTextNode(String(value)))
    }
  }
}

const matchesSimpleToken = (el: TestElement, token: string): boolean => {
  if (token.startsWith(':not(') && token.endsWith(')')) {
    const inner = token.slice(5, -1)
    return !matchesCompoundSelector(el, inner)
  }
  if (token.startsWith('#')) {
    return el.id === token.slice(1)
  }
  if (token.startsWith('.')) {
    const cls = token.slice(1)
    return el.className.split(/\s+/).includes(cls)
  }
  if (token.startsWith('[') && token.endsWith(']')) {
    const inner = token.slice(1, -1)
    const eqIndex = inner.indexOf('=')
    if (eqIndex === -1) {
      return el.hasAttribute(inner.trim())
    }
    const attrName = inner.slice(0, eqIndex).trim()
    const rawVal = inner
      .slice(eqIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    return el.getAttribute(attrName) === rawVal
  }
  return el.tagName.toLowerCase() === token.toLowerCase()
}

const tokenizeCompoundSelector = (selector: string): string[] => {
  const tokens: string[] = []
  let i = 0
  const s = selector.trim()
  while (i < s.length) {
    if (s.startsWith(':not(', i)) {
      let depth = 0
      const start = i
      while (i < s.length) {
        if (s[i] === '(') depth++
        else if (s[i] === ')') {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
        i++
      }
      tokens.push(s.slice(start, i))
    } else if (s[i] === '[') {
      const end = s.indexOf(']', i)
      const next = end === -1 ? s.length : end + 1
      tokens.push(s.slice(i, next))
      i = next
    } else if (s[i] === '#' || s[i] === '.') {
      const start = i
      i++
      while (i < s.length && !['#', '.', '[', ':'].includes(s[i])) i++
      tokens.push(s.slice(start, i))
    } else {
      const start = i
      while (i < s.length && !['#', '.', '[', ':'].includes(s[i])) i++
      tokens.push(s.slice(start, i))
    }
  }
  return tokens.filter(Boolean)
}

const matchesCompoundSelector = (el: TestElement, selector: string): boolean => {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) =>
      tokenizeCompoundSelector(part).every((tok) => matchesSimpleToken(el, tok))
    )
}

export class TestElement extends TestNode {
  tagName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  style: Record<string, string> = {}
  attributes = new Map<string, string>()
  dataset: Record<string, string | undefined>

  constructor(tagName: string, ownerDocument: TestDocument) {
    super(1, tagName.toUpperCase(), ownerDocument)
    this.tagName = tagName.toUpperCase()
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined
        const attr =
          'data-' + prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
        return this.getAttribute(attr) ?? undefined
      },
      set: (_target, prop, value) => {
        if (typeof prop === 'string') {
          const attr =
            'data-' + prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
          this.setAttribute(attr, String(value))
        }
        return true
      },
    })
  }

  get id(): string {
    return this.getAttribute('id') ?? ''
  }

  set id(value: string) {
    if (value === '') {
      this.removeAttribute('id')
    } else {
      this.setAttribute('id', String(value))
    }
  }

  get className(): string {
    return this.getAttribute('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', String(value))
  }

  get tabIndex(): number {
    if (this.hasAttribute('tabindex')) {
      return Number(this.getAttribute('tabindex'))
    }
    return this.tagName === 'BUTTON' ? 0 : -1
  }

  set tabIndex(value: number) {
    this.setAttribute('tabindex', String(value))
  }

  get hidden(): boolean {
    return this.hasAttribute('hidden')
  }

  set hidden(value: boolean) {
    if (value) {
      this.setAttribute('hidden', '')
    } else {
      this.removeAttribute('hidden')
    }
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  set disabled(value: boolean) {
    if (value) {
      this.setAttribute('disabled', '')
    } else {
      this.removeAttribute('disabled')
    }
  }

  get type(): string {
    if (this.hasAttribute('type')) {
      return this.getAttribute('type')!
    }
    return this.tagName === 'BUTTON' ? 'submit' : ''
  }

  set type(value: string) {
    this.setAttribute('type', String(value))
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  focus() {
    if (!this.disabled && !this.hidden) {
      this.ownerDocument.activeElement = this
    }
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body
    }
  }

  matches(selector: string): boolean {
    return matchesCompoundSelector(this, selector)
  }

  closest(selector: string): TestElement | null {
    let cur: TestNode | null = this
    while (cur) {
      if (cur.nodeType === 1 && (cur as TestElement).matches(selector)) {
        return cur as TestElement
      }
      cur = cur.parentNode
    }
    return null
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): TestElement[] {
    const results: TestElement[] = []
    const visit = (node: TestNode) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          const el = child as TestElement
          if (el.matches(selector)) {
            results.push(el)
          }
          visit(el)
        }
      }
    }
    visit(this)
    return results
  }

  get children(): TestElement[] {
    return this.childNodes.filter(
      (child): child is TestElement => child.nodeType === 1
    )
  }
}

export class TestIFrameElement extends TestElement {}

export class TestText extends TestNode {
  nodeValue: string

  constructor(text: string, ownerDocument: TestDocument) {
    super(3, '#text', ownerDocument)
    this.nodeValue = String(text)
  }

  override get textContent(): string {
    return this.nodeValue
  }

  override set textContent(value: string) {
    this.nodeValue = String(value)
  }
}

export class TestComment extends TestNode {
  nodeValue: string

  constructor(text: string, ownerDocument: TestDocument) {
    super(8, '#comment', ownerDocument)
    this.nodeValue = String(text)
  }
}

export class TestDocument extends TestNode {
  documentElement: TestElement
  body: TestElement
  activeElement: TestElement
  defaultView: Record<string, unknown> | null = null

  constructor() {
    super(9, '#document')
    this.ownerDocument = this
    this.documentElement = new TestElement('html', this)
    this.body = new TestElement('body', this)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
  }

  createElement(tagName: string): TestElement {
    if (tagName.toLowerCase() === 'iframe') {
      return new TestIFrameElement('iframe', this)
    }
    return new TestElement(tagName, this)
  }

  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName)
  }

  createTextNode(text: string): TestText {
    return new TestText(text, this)
  }

  createComment(text: string): TestComment {
    return new TestComment(text, this)
  }

  getElementById(id: string): TestElement | null {
    return this.documentElement.querySelector(`#${id}`)
  }

  querySelector(selector: string): TestElement | null {
    return this.documentElement.querySelector(selector)
  }

  querySelectorAll(selector: string): TestElement[] {
    return this.documentElement.querySelectorAll(selector)
  }
}

const installDomGlobals = (): TestDocument => {
  const doc = new TestDocument()
  const win: Record<string, unknown> = {
    document: doc,
    Event: TestEvent,
    KeyboardEvent: TestEvent,
    MouseEvent: TestEvent,
    Node: TestNode,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestIFrameElement,
    navigator: { userAgent: 'node' },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  doc.defaultView = win

  const g = globalThis as Record<string, unknown>
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.window = win
  g.document = doc
  g.Event = TestEvent
  g.KeyboardEvent = TestEvent
  g.MouseEvent = TestEvent
  g.Node = TestNode
  g.Element = TestElement
  g.HTMLElement = TestElement
  g.HTMLIFrameElement = TestIFrameElement
  Object.defineProperty(globalThis, 'navigator', {
    value: win.navigator,
    configurable: true,
    writable: true,
  })

  return doc
}

export const render = (ui: React.ReactElement) => {
  const doc = installDomGlobals()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(ui)
  })

  return {
    document: doc,
    container,
    rerender: (nextUi: React.ReactElement) => {
      act(() => {
        root.render(nextUi)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
    },
  }
}

export const fireClick = (element: TestElement): boolean => {
  let notPrevented = true
  act(() => {
    element.focus()
    notPrevented = element.dispatchEvent(
      new TestEvent('click', { bubbles: true, cancelable: true })
    )
  })
  return notPrevented
}

export const fireKeyDown = (
  element: TestElement,
  init: EventInitDict
): TestEvent => {
  const event = new TestEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    element.dispatchEvent(event)
  })
  return event
}
