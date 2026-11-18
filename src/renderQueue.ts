type Pending = { pane: number; priority: () => number; start: () => void }

export function createRenderQueue(limit: number) {
  const pending: Pending[] = []
  let running = 0, background = 0, lastPane = -1
  function pump() {
    while (running < limit) {
      let next: Pending | undefined
      for (const job of pending) {
        const priority = job.priority()
        if (priority >= 2 && background > 0) continue
        if (!next || priority < next.priority() ||
          (priority === next.priority() && next.pane === lastPane && job.pane !== lastPane)) next = job
      }
      if (!next) return
      pending.splice(pending.indexOf(next), 1)
      next.start()
    }
  }
  return function acquire(pane: number, priority: () => number, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const abort = () => {
        pending.splice(pending.indexOf(job), 1)
        reject(signal.reason)
        pump()
      }
      const job = { pane, priority, start() {
        signal.removeEventListener('abort', abort)
        const isBackground = priority() >= 2
        running++; lastPane = pane
        if (isBackground) background++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          running--
          if (isBackground) background--
          pump()
        })
      } }
      signal.addEventListener('abort', abort, { once: true })
      pending.push(job)
      pump()
    })
  }
}
