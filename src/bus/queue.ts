/**
 * 异步队列 —— 生产者-消费者模式
 *
 * put() 不会阻塞，get() 在队列为空时等待直到有元素可用。
 * 替代 Python asyncio.Queue 在 TypeScript 中的角色。
 */
export class AsyncQueue<T> {
  private items: T[] = []
  private resolvers: ((value: T) => void)[] = []

  /** 添加元素到队列 */
  put(item: T): void {
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve(item)
    } else {
      this.items.push(item)
    }
  }

  /** 取出下一个元素（队列为空时阻塞等待） */
  async get(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) {
      return item
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  /** 当前队列长度 */
  get size(): number {
    return this.items.length
  }
}
