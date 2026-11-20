import React from 'react'

export type TableProps = React.TableHTMLAttributes<HTMLTableElement> & {
  caption?: React.ReactNode
  hideCaption?: boolean
}

export const Table = ({
  children,
  caption,
  hideCaption = false,
  className = '',
  ...props
}: TableProps) => (
  <table className={`w-full border ${className}`.trim()} {...props}>
    {caption ? (
      <caption
        className={hideCaption ? 'sr-only' : 'p-2 text-left font-semibold'}
      >
        {caption}
      </caption>
    ) : null}
    {children}
  </table>
)

export const TableHeader = ({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={className} {...props}>
    {children}
  </thead>
)

export const TableBody = ({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={className} {...props}>
    {children}
  </tbody>
)

export const TableRow = ({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={className} {...props}>
    {children}
  </tr>
)

export const TableHead = ({
  children,
  scope = 'col',
  className = '',
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th scope={scope} className={className} {...props}>
    {children}
  </th>
)

export const TableRowHeader = ({
  children,
  scope = 'row',
  className = '',
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    scope={scope}
    className={`text-left font-normal ${className}`.trim()}
    {...props}
  >
    {children}
  </th>
)

export const TableCell = ({
  children,
  className = '',
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={className} {...props}>
    {children}
  </td>
)

export default Table
