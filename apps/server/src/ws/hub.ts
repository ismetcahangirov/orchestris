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
  /**
   * Qlobal abunələr — canlı zolaq (Faza 5A).
   *
   * Task abunəliklərindən AYRIDIR: bura yalnız `activity` mesajları gedir,
   * hadisə deltaları YOX. Bir kanalda birləşdirsəydik, zolaq açıq olan hər
   * brauzer bütün icraların hərf-hərf axınını alardı — halbuki zolaq ekranın
   * ən kiçik elementidir.
   */
  private readonly globalSockets = new Set<Socket>()

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

  subscribeGlobal(socket: Socket): void {
    this.globalSockets.add(socket)
  }

  unsubscribeGlobal(socket: Socket): void {
    this.globalSockets.delete(socket)
  }

  globalCount(): number {
    return this.globalSockets.size
  }

  /** Socket bağlandıqda bütün abunəliklərini təmizləyir. */
  removeSocket(socket: Socket): void {
    for (const [taskId, set] of this.byTask) {
      set.delete(socket)
      if (set.size === 0) this.byTask.delete(taskId)
    }
    this.globalSockets.delete(socket)
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
    this.send(set, message)
  }

  /** Canlı zolaq yayımı — YALNIZ `activity`, delta heç vaxt. */
  broadcastGlobal(message: WsServerMessage): void {
    this.send(this.globalSockets, message)
  }

  private send(sockets: Iterable<Socket>, message: WsServerMessage): void {
    const payload = JSON.stringify(message)
    for (const socket of sockets) {
      try {
        socket.send(payload)
      } catch {
        // Bağlanmış socket — növbəti təmizləmədə silinəcək.
      }
    }
  }
}
