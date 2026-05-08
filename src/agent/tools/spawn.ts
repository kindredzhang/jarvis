/**
 * SpawnTool —— 子代理生成工具
 *
 * 允许 LLM 在 ReAct 循环中 spawn 子代理处理独立任务。
 * 子代理完成后通过 SubagentManager 的回调通知主 Agent。
 */

import { Tool, defineParams } from './base'
import type { SubagentManager } from '../subagent'

export class SpawnTool extends Tool {
  readonly name = 'spawn'
  readonly description =
    'Spawn a subagent to handle a task in the background. ' +
    'Use this for complex or time-consuming tasks that can run independently. ' +
    'The subagent will complete the task and report back when done.'

  readonly parameters = defineParams({
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task for the subagent to complete',
        minLength: 1,
      },
      label: {
        type: 'string',
        description: 'Optional short label for the task (for display)',
      },
    },
    required: ['task'],
  })

  private manager: SubagentManager

  constructor(manager: SubagentManager) {
    super()
    this.manager = manager
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const task = args.task as string | undefined
    if (!task) return 'Error: No task provided for subagent.'

    const label = args.label as string | undefined
    return this.manager.spawn(task, { label })
  }
}
