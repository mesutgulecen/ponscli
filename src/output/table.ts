import { visibleWidth } from './color.js'

export interface Column {
  header: string
  /** Right-align the cell body. Use for numeric columns. */
  align?: 'left' | 'right'
}

/**
 * Render a fixed-width table for human output.
 *
 * Column widths are computed from the visible width of each cell, so colourized
 * cells line up instead of being padded by the length of their escape codes.
 * There is no wrapping: a terminal narrower than the content scrolls, which is
 * preferable to reflowing an address across two lines.
 */
export function renderTable(columns: Column[], rows: string[][], indent = ''): string {
  const widths = columns.map((column, index) =>
    rows.reduce(
      (widest, row) => Math.max(widest, visibleWidth(row[index] ?? '')),
      visibleWidth(column.header),
    ),
  )

  const pad = (text: string, width: number, align: 'left' | 'right'): string => {
    const padding = ' '.repeat(Math.max(0, width - visibleWidth(text)))
    return align === 'right' ? padding + text : text + padding
  }

  const line = (cells: string[]): string =>
    (
      indent +
      cells
        .map((cell, index) => pad(cell, widths[index] ?? 0, columns[index]?.align ?? 'left'))
        .join('  ')
    ).trimEnd()

  // A table whose columns are all unnamed is a label/value layout, not a
  // listing: a header rule above two blank cells is furniture with nothing in
  // it. Aligning the columns is still the point, so this stays one function.
  if (columns.every((column) => column.header === '')) return rows.map(line).join('\n')

  return [
    line(columns.map((column) => column.header)),
    indent + widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(line),
  ].join('\n')
}
