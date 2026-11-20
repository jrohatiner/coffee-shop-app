declare module 'react-test-renderer' {
  import * as React from 'react'

  export interface ReactTestInstance {
    instance: any
    type: any
    props: { [propName: string]: any }
    parent: ReactTestInstance | null
    children: Array<ReactTestInstance | string>
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance
    findByType(type: any): ReactTestInstance
    findByProps(props: { [propName: string]: any }): ReactTestInstance
    findAll(
      predicate: (node: ReactTestInstance) => boolean,
      options?: { deep?: boolean }
    ): ReactTestInstance[]
    findAllByType(type: any, options?: { deep?: boolean }): ReactTestInstance[]
    findAllByProps(
      props: { [propName: string]: any },
      options?: { deep?: boolean }
    ): ReactTestInstance[]
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance
    toJSON(): any
    toTree(): any
    update(nextElement: React.ReactNode): void
    unmount(): void
    getInstance(): any
  }

  export function create(
    nextElement: React.ReactNode,
    options?: { createNodeMock?: (element: any) => any }
  ): ReactTestRenderer

  export function act(callback: () => void | Promise<void>): Promise<void>

  type _ReactTestRenderer = ReactTestRenderer
  type _ReactTestInstance = ReactTestInstance

  namespace TestRenderer {
    export type ReactTestRenderer = _ReactTestRenderer
    export type ReactTestInstance = _ReactTestInstance
  }

  const TestRenderer: {
    create: typeof create
    act: typeof act
  }
  export default TestRenderer
}
