/**
 * OpenAI Responses API — converters and SSE stream parsing.
 *
 * Port of nanobot/providers/openai_responses/.
 */

export { convertMessages, convertTools, splitToolCallId } from './converters'
export { consumeSse, parseResponseOutput, type ResponseToolCall } from './parsing'
