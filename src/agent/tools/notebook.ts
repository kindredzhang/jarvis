/**
 * NotebookEditTool —— edit Jupyter .ipynb notebooks
 *
 * Ported from Python original agent/tools/notebook.py.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import crypto from 'node:crypto'
import { defineParams } from './base'
import { FsTool } from './fs'

// ---- Helpers ----

function _newCell(source: string, cellType: string = 'code', generateId = false): Record<string, unknown> {
  const cell: Record<string, unknown> = {
    cell_type: cellType,
    source,
    metadata: {},
  }
  if (cellType === 'code') {
    cell['outputs'] = []
    cell['execution_count'] = null
  }
  if (generateId) {
    cell['id'] = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  }
  return cell
}

function _makeEmptyNotebook(): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    cells: [],
  }
}

// ---- NotebookEditTool ----

const _VALID_CELL_TYPES = new Set(['code', 'markdown'])
const _VALID_EDIT_MODES = new Set(['replace', 'insert', 'delete'])

export class NotebookEditTool extends FsTool {
  readonly name = 'notebook_edit'
  readonly description =
    'Edit a Jupyter notebook (.ipynb) cell. ' +
    'Modes: replace (default) replaces cell content, ' +
    'insert adds a new cell after the target index, ' +
    'delete removes the cell at the index. ' +
    'cell_index is 0-based.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .ipynb notebook file' },
      cell_index: { type: 'integer', description: '0-based index of the cell to edit', minimum: 0 },
      new_source: { type: 'string', description: 'New source content for the cell' },
      cell_type: {
        type: 'string',
        description: "Cell type: 'code' or 'markdown' (default: code)",
        enum: ['code', 'markdown'],
      },
      edit_mode: {
        type: 'string',
        description: "Mode: 'replace' (default), 'insert' (after target), or 'delete'",
        enum: ['replace', 'insert', 'delete'],
      },
    },
    required: ['path', 'cell_index'],
  })

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const path = (args.path as string) ?? ''
      const cellIndex = (args.cell_index as number) ?? 0
      const newSource = (args.new_source as string) ?? ''
      const cellType = (args.cell_type as string) ?? 'code'
      const editMode = (args.edit_mode as string) ?? 'replace'

      if (!path) return 'Error: path is required'

      if (!path.endsWith('.ipynb')) {
        return 'Error: notebook_edit only works on .ipynb files. Use edit_file for other files.'
      }

      if (!_VALID_EDIT_MODES.has(editMode)) {
        return (
          `Error: Invalid edit_mode '${editMode}'. ` +
          'Use one of: replace, insert, delete.'
        )
      }

      if (!_VALID_CELL_TYPES.has(cellType)) {
        return (
          `Error: Invalid cell_type '${cellType}'. ` +
          'Use one of: code, markdown.'
        )
      }

      const fp = this._resolve(path)

      // Create new notebook if file doesn't exist and mode is insert
      if (!existsSync(fp)) {
        if (editMode !== 'insert') {
          return `Error: File not found: ${path}`
        }
        const nb = _makeEmptyNotebook()
        const cell = _newCell(newSource, cellType, true)
        ;(nb.cells as Record<string, unknown>[]).push(cell)
        mkdirSync(dirname(fp), { recursive: true })
        writeFileSync(fp, JSON.stringify(nb, null, 1), 'utf-8')
        return `Successfully created ${fp} with 1 cell`
      }

      let nb: Record<string, unknown>
      try {
        const raw = readFileSync(fp, 'utf-8')
        nb = JSON.parse(raw) as Record<string, unknown>
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return `Error: Failed to parse notebook: ${msg}`
      }

      const cells = (nb.cells ?? []) as Record<string, unknown>[]
      const nbformatMinor = (nb.nbformat_minor as number) ?? 0
      const generateId = (nb.nbformat as number) >= 4 && nbformatMinor >= 5

      if (editMode === 'delete') {
        if (cellIndex < 0 || cellIndex >= cells.length) {
          return `Error: cell_index ${cellIndex} out of range (notebook has ${cells.length} cells)`
        }
        cells.splice(cellIndex, 1)
        nb.cells = cells
        writeFileSync(fp, JSON.stringify(nb, null, 1), 'utf-8')
        return `Successfully deleted cell ${cellIndex} from ${fp}`
      }

      if (editMode === 'insert') {
        const insertAt = Math.min(cellIndex + 1, cells.length)
        const cell = _newCell(newSource, cellType, generateId)
        cells.splice(insertAt, 0, cell)
        nb.cells = cells
        writeFileSync(fp, JSON.stringify(nb, null, 1), 'utf-8')
        return `Successfully inserted cell at index ${insertAt} in ${fp}`
      }

      // Default: replace
      if (cellIndex < 0 || cellIndex >= cells.length) {
        return `Error: cell_index ${cellIndex} out of range (notebook has ${cells.length} cells)`
      }
      const targetCell = cells[cellIndex]!
      targetCell['source'] = newSource
      if (cellType && targetCell['cell_type'] !== cellType) {
        targetCell['cell_type'] = cellType
        if (cellType === 'code') {
          if (!('outputs' in targetCell)) targetCell['outputs'] = []
          if (!('execution_count' in targetCell)) targetCell['execution_count'] = null
        } else {
          delete targetCell['outputs']
          delete targetCell['execution_count']
        }
      }
      nb.cells = cells
      writeFileSync(fp, JSON.stringify(nb, null, 1), 'utf-8')
      return `Successfully edited cell ${cellIndex} in ${fp}`
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('outside allowed directory')) return `Error: ${msg}`
      return `Error editing notebook: ${msg}`
    }
  }
}
