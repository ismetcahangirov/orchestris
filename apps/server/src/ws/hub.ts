import type { WsServerMessage } from '@orchestris/shared'

export interface Socket {
  send(data: string): void
}

/**
 * Task-a görə abunəlik idarəsi. Bir socket bir neçə task izləyə bilər.
 *
 * Yayım YALNIZ abunə olan socket-lərə gedir — 50 task açıqdırsa hər hadisəni
 * hər socket-ə göndərmək lazımsız trafikdir.
 */
export class WsHub {
  private readonly byTask = new Map<string, Set<Socket>>()

  subscribe(taskId: string, socket: Socket): void {
    let set = this.byTask.get(taskId)
    if (set === undefined) {
      set = new Set()
      this.byTask.set(taskId, set)
    }
    set.add(socket)
  }

  unsubscribe(taskId: string, socket: Socket): void {
    const set = this.byTask.get(taskId)
    if (set === undefined) return
    set.delete(socket)
    if (set.size === 0) this.byTask.delete(taskId)
  }

  /** Socket bağlandıqda bütün abunəliklərini təmizləyir. */
  removeSocket(socket: Socket): void {
    for (const [taskId, set] of this.byTask) {
      set.delete(socket)
      if (set.size === 0) this.byTask.delete(taskId)
    }
  }

  subscriberCount(taskId: string): number {
    return this.byTask.get(taskId)?.size ?? 0
  }

  taskCount(): number {
    return this.byTask.size
  }

  broadcast(taskId: string, message: WsServerMessage): void {
    const set = this.byTask.get(taskId)
    if (set === undefined) return
    const payload = JSON.stringify(message)
    for (const socket of set) {
      try {
        socket.send(payload)
      } catch {
        // Bağlanmış socket — növbəti təmizləmədə silinəcək.
      }
    }
  }
}
