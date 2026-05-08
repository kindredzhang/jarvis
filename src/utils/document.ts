/**
 * 文档提取工具 —— PDF/Office 文档文本提取
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - PDF：调用 python3 pymupdf（需 pip install pymupdf）
 * - .docx：优先 macOS textutil，回退 ZIP+XML 解析
 * - .xlsx / .pptx：ZIP+XML 解析（不依赖外部库）
 * - 无图片/表格/格式保留
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

// ---- ZIP 解析（最小实现，无需外部库） ----

interface ZipEntry {
  name: string
  data: Buffer
}

/** 从 Buffer 中解析 ZIP 文件的文件列表 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []

  // 从文件末尾找 EOCD signature (0x06054b50)
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) return entries

  // 中央目录偏移
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  const numEntries = buf.readUInt16LE(eocdOffset + 10)

  let pos = cdOffset
  for (let i = 0; i < numEntries; i++) {
    if (buf[pos] !== 0x50 || buf[pos+1] !== 0x4b || buf[pos+2] !== 0x01 || buf[pos+3] !== 0x02) break

    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const compMethod = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const uncompSize = buf.readUInt32LE(pos + 24)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8')

    // 读取本地文件头后的数据
    let data = Buffer.alloc(0)
    if (compSize > 0) {
      const localHeaderOffset = localOffset + 30 + nameLen + buf.readUInt16LE(localOffset + 28)
      const raw = buf.slice(localHeaderOffset, localHeaderOffset + compSize)
      if (compMethod === 0) {
        data = raw
      } else if (compMethod === 8) {
        try { data = inflateRawSync(raw) } catch { data = raw }
      } else {
        data = raw
      }
    }

    entries.push({ name, data })
    pos += 46 + nameLen + extraLen + commentLen
  }

  return entries
}

/** 从 ZIP 条目中提取 XML 文本 */
function extractXmlText(data: Buffer): string {
  const text = data.toString('utf-8')
  // 去掉 XML 标签，保留文本内容
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\s\n\r]+/g, ' ')
    .trim()
}

// ---- 文档提取 ----

/** 解析 .docx 文件文本 */
function extractDocx(fp: string): string | null {
  const buf = readFileSync(fp)
  const entries = readZipEntries(buf)

  // 尝试 textutil（macOS 原生）
  const textutil = spawnSync('textutil', ['-convert', 'txt', fp, '-stdout'], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
  if (textutil.status === 0 && textutil.stdout?.trim()) {
    return textutil.stdout.trim()
  }

  // 回退：解析 word/document.xml
  const docEntry = entries.find((e) => e.name === 'word/document.xml')
  if (!docEntry) return null
  return extractXmlText(docEntry.data)
}

/** 解析 .xlsx 文件文本 */
function extractXlsx(fp: string): string | null {
  const buf = readFileSync(fp)
  const entries = readZipEntries(buf)

  // 读取共享字符串表
  const sharedStringsEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml')
  const ssTexts: string[] = []
  if (sharedStringsEntry) {
    const content = sharedStringsEntry.data.toString('utf-8')
    const siRegex = /<si>([\s\S]*?)<\/si>/g
    let match: RegExpExecArray | null
    while ((match = siRegex.exec(content)) !== null) {
      const tMatch = match[1]!.match(/<t[^>]*>([\s\S]*?)<\/t>/)
      if (tMatch) {
        ssTexts.push(tMatch[1]!.replace(/<[^>]*>/g, '').trim())
      } else {
        ssTexts.push('')
      }
    }
  }

  const parts: string[] = []
  // 遍历所有工作表
  for (const entry of entries) {
    if (!entry.name.startsWith('xl/worksheets/sheet') || !entry.name.endsWith('.xml')) continue
    const content = entry.data.toString('utf-8')
    const cellRegex = /<c[^>]*>(?:<v>(\d+)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>|)(?:<v>(\d+)<\/v>)?(?:\s*<f>[\s\S]*?<\/f>)?/g
    // Simpler: extract all <t> text nodes within the sheet
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tRegex.exec(content)) !== null) {
      const text = tMatch[1]!.replace(/<[^>]*>/g, '').trim()
      if (text) parts.push(text)
    }
  }

  // Also extract from shared strings (referenced by <v>index</v>)
  const vRegex = /<c[^>]*><v>(\d+)<\/v>/g
  let vMatch: RegExpExecArray | null
  while ((vMatch = vRegex.exec(buf.toString('utf-8'))) !== null) {
    const idx = parseInt(vMatch[1]!, 10)
    if (idx < ssTexts.length && ssTexts[idx]) {
      parts.push(ssTexts[idx]!)
    }
  }

  return parts.length > 0 ? parts.join('\n') : null
}

/** 解析 .pptx 文件文本 */
function extractPptx(fp: string): string | null {
  const buf = readFileSync(fp)
  const entries = readZipEntries(buf)

  const parts: string[] = []
  // 遍历所有幻灯片
  for (const entry of entries) {
    if (!entry.name.startsWith('ppt/slides/slide') || !entry.name.endsWith('.xml')) continue
    const text = extractXmlText(entry.data)
    if (text) {
      parts.push(`--- Slide ${entry.name.match(/slide(\d+)/)?.[1] ?? '?'} ---\n${text}`)
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

/** 解析 PDF 文件文本 */
function extractPdf(fp: string): string | null {
  // 尝试 python3 pymupdf
  const script = `
import sys
try:
    import fitz
    doc = fitz.open(sys.argv[1])
    for page in doc:
        sys.stdout.write(page.get_text())
        sys.stdout.write('\\n--- Page Break ---\\n')
    doc.close()
except ImportError:
    sys.stdout.write('__NEED_PYMUPDF__')
`
  const result = spawnSync('python3', ['-c', script, fp], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  })

  if (result.status === 0 && result.stdout && !result.stdout.includes('__NEED_PYMUPDF__')) {
    return result.stdout.trim()
  }

  // 尝试 pdftotext
  const pdftotext = spawnSync('pdftotext', [fp, '-'], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  })
  if (pdftotext.status === 0 && pdftotext.stdout?.trim()) {
    return pdftotext.stdout.trim()
  }

  return null
}

// ---- 公开接口 ----

export function extractDocumentText(fp: string): string | null {
  const ext = fp.toLowerCase()
  if (ext.endsWith('.pdf')) return extractPdf(fp)
  if (ext.endsWith('.docx')) return extractDocx(fp)
  if (ext.endsWith('.xlsx')) return extractXlsx(fp)
  if (ext.endsWith('.pptx')) return extractPptx(fp)
  return null
}
