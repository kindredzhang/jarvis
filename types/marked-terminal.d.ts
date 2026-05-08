declare module 'marked-terminal' {
  import { type MarkedExtension } from 'marked'

  export interface MarkedTerminalOptions {
    code?: (text: string) => string
    blockquote?: (text: string) => string
    html?: (text: string) => string
    heading?: (text: string) => string
    firstHeading?: (text: string) => string
    hr?: (text: string) => string
    listitem?: (text: string) => string
    table?: (text: string) => string
    paragraph?: (text: string) => string
    strong?: (text: string) => string
    em?: (text: string) => string
    codespan?: (text: string) => string
    del?: (text: string) => string
    link?: (text: string) => string
    href?: (text: string) => string
    text?: (text: string) => string
    unescape?: boolean
    emoji?: boolean
    width?: number
    showSectionPrefix?: boolean
    reflowText?: boolean
    tab?: number
    tableOptions?: Record<string, unknown>
    image?: (href: string, title: string | null, text: string) => string
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension

  export default class Renderer {
    constructor(options?: MarkedTerminalOptions, highlightOptions?: Record<string, unknown>)
  }
}
