import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface SpawnLinesInput {
  command: string
  args: readonly string[]
  useShell: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SpawnedLines {
  readonly pid: number | undefined
  /** stdout sətirləri (CRLF və LF hər ikisi düzgün ayrılır) */
  readonly lines: AsyncIterable<string>
  readonly exitCode: Promise<number | null>
  readonly killed: boolean
  stderrText(): string
  spawnError(): Error | null
  /** Bütün proses AĞACINI öldürür. Windows-da `taskkill /T /F`. */
  kill(): Promise<void>
}

/**
 * CLI prosesini spawn edir və stdout-u sətir-sətir verir.
 *
 * Kritik seçimlər (hər biri real eksperimentlə təsdiqlənib):
 *  - `stdin: 'ignore'` — `codex exec` stdin gözləyir və açıq stdin ilə əbədi
 *    donur ("Reading additional input from stdin...").
 *  - stderr AYRICA toplanır — `codex` log sətirlərini stdout-a qarışdırmasın.
 *  - `detached` yalnız POSIX-də — proses qrupu ilə öldürmək üçün.
 */
export function spawnLines(input: SpawnLinesInput): SpawnedLines {
  const isWin = process.platform === 'win32'

  const child: ChildProcess = spawn(input.command, [...input.args], {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    env: input.env ?? process.env,
    shell: input.useShell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,
  })

  let stderr = ''
  let spawnErr: Error | null = null
  let wasKilled = false

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.on('error', (err: Error) => {
    spawnErr = err
  })

  const exitCode = new Promise<number | null>((res) => {
    child.on('close', (code) => res(code))
    child.on('error', () => res(-1))
  })

  async function kill(): Promise<void> {
    if (wasKilled || child.exitCode !== null) return
    wasKilled = true
    const pid = child.pid
    if (pid === undefined) return

    if (isWin) {
      // Shim-i öldürmək uşaq .exe-ni öldürmür. /T bütün ağacı alır.
      await new Promise<void>((res) => {
        const tk = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
        tk.on('close', () => res())
        tk.on('error', () => res())
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* proses artıq ölüb */
        }
      }
    }
    await exitCode
  }

  async function* readLines(): AsyncGenerator<string> {
    if (!child.stdout) return
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    try {
      for await (const line of rl) yield line
    } finally {
      rl.close()
    }
    await exitCode
  }

  return {
    get pid() {
      return child.pid
    },
    lines: readLines(),
    exitCode,
    get killed() {
      return wasKilled
    },
    stderrText: () => stderr,
    spawnError: (): Error | null => spawnErr,
    kill,
  }
}
