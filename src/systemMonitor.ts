import { execFile } from 'child_process'
import * as os from 'os'

import { Logger } from './logger'

/** How often the monitor samples the machine, in milliseconds. */
export const SYSTEM_SAMPLE_INTERVAL_MS = 2000

/** Local CPU stats for one sample. */
export interface CpuStats {
  /** Processor model name as reported by the OS (empty when the OS omits it). */
  model: string
  /** Advertised clock speed in MHz, when reported. */
  speed?: number
  /** Logical core count. */
  cores: number
  /** Utilization since the previous sample, 0-100; undefined until the second sample. */
  usage?: number
}

/** Local RAM stats for one sample. */
export interface MemoryStats {
  /** Total physical memory, in bytes. */
  total: number
  /** Bytes currently free, as reported by `os.freemem()`. */
  free: number
  /** `total - free`, in bytes. */
  used: number
  /** `used / total * 100`, rounded to one decimal place. */
  usage: number
}

/** One graphics adapter as reported by the sampling source. */
export interface GpuStats {
  /** Adapter name, e.g. `NVIDIA GeForce RTX 4060`. */
  name: string
  /** Core utilization 0-100; only `nvidia-smi` reports this. */
  usage?: number
  /** VRAM in use, in bytes. */
  memoryUsed?: number
  /** Total VRAM, in bytes. */
  memoryTotal?: number
  /** Core temperature in degrees Celsius. */
  temperature?: number
}

/** Everything the tree's System section renders, from one sample. */
export interface SystemSnapshot {
  cpu: CpuStats
  memory: MemoryStats
  gpus: GpuStats[]
  /** Whether `gpus` carries live values (i.e. came from `nvidia-smi`). */
  gpuLive: boolean
  /** `Date.now()` when this sample was taken. */
  updatedAt: number
}

/**
 * Utilization between two `os.cpus()` readings, as a 0-100 percentage. The
 * per-core times are cumulative counters, so the difference across all cores
 * gives the share of time that was *not* idle. Returns undefined when there is
 * no previous reading to compare against (first sample) or the core count
 * changed.
 */
function cpuUsage(current: os.CpuInfo[], previous: os.CpuInfo[] | undefined): number | undefined {
  if (!previous || previous.length !== current.length || current.length === 0) return undefined
  let idle = 0
  let total = 0
  for (let i = 0; i < current.length; i++) {
    const now = current[i].times
    const before = previous[i].times
    const coreIdle = now.idle - before.idle
    const coreTotal = (now.user - before.user) + (now.nice - before.nice) +
      (now.sys - before.sys) + (now.irq - before.irq) + coreIdle
    // Two back-to-back readings (or a counter reset) give no usable delta.
    if (coreTotal <= 0) continue
    idle += coreIdle
    total += coreTotal
  }
  if (total <= 0) return undefined
  return Math.round((1 - idle / total) * 1000) / 10
}

/**
 * Turn `nvidia-smi` CSV rows (in MiB, `N/A` allowed) into `GpuStats`. The
 * queried fields never contain a comma themselves, so a plain split is safe.
 */
function parseNvidiaSmi(stdout: string): GpuStats[] {
  const gpus: GpuStats[] = []
  const number = (value: string): number | undefined => {
    const parsed = Number(value)
    return value !== '' && Number.isFinite(parsed) ? parsed : undefined
  }
  const mib = (value: string): number | undefined => {
    const parsed = number(value)
    return parsed === undefined ? undefined : parsed * 1024 * 1024
  }
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.split(',').map((column) => column.trim())
    const [name, usage, used, total, temperature] = columns
    if (!name) continue
    gpus.push({
      name,
      usage: number(usage ?? ''),
      memoryUsed: mib(used ?? ''),
      memoryTotal: mib(total ?? ''),
      temperature: number(temperature ?? '')
    })
  }
  return gpus
}

/**
 * Query the NVIDIA management CLI for every adapter's name, utilization, VRAM
 * and temperature. Resolves undefined when `nvidia-smi` is missing or reports
 * nothing (no NVIDIA GPU or driver), so the caller can fall back.
 */
function queryNvidiaSmi(): Promise<GpuStats[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits'
      ],
      { windowsHide: true, timeout: 5000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return resolve(undefined)
        const gpus = parseNvidiaSmi(stdout)
        resolve(gpus.length > 0 ? gpus : undefined)
      }
    )
  })
}

/**
 * Adapter names from the OS when `nvidia-smi` is unavailable (AMD/Intel GPUs,
 * machines without the NVIDIA driver). Windows reads WMI, Linux reads `lspci`,
 * any other platform resolves to an empty list. These entries carry no
 * utilization — only `nvidia-smi` reports that — so their rows render as "n/a".
 */
function listGpusStatic(): Promise<GpuStats[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance -ClassName Win32_VideoController | ForEach-Object { $_.Name }'
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 10000, encoding: 'utf8' },
        (error, stdout) => {
          if (error) return resolve([])
          const names = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
          resolve(names.map((name) => ({ name })))
        }
      )
    })
  }
  if (process.platform === 'linux') {
    return new Promise((resolve) => {
      execFile('lspci', ['-mm'], { timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve([])
        const gpus: GpuStats[] = []
        for (const line of stdout.split(/\r?\n/)) {
          if (!/VGA compatible controller|3D controller|Display controller/.test(line)) continue
          // `lspci -mm` quotes each field: class, vendor, device, ...
          const fields = line.match(/"([^"]*)"/g)
          if (!fields || fields.length < 3) continue
          const clean = (field: string): string => field.replace(/"/g, '')
          gpus.push({ name: `${clean(fields[1])} ${clean(fields[2])}`.trim() })
        }
        resolve(gpus)
      })
    })
  }
  return Promise.resolve([])
}

/**
 * Samples the local machine on a timer so the tree's System section can show
 * CPU, GPU and RAM utilization in real time.
 *
 * CPU and RAM come from Node's `os` module (in-process, cheap) on every tick.
 * GPUs need a subprocess, so that part is gated: `gpuEnabled` decides whether
 * the probe (and later refreshes) run — the provider ties it to "the System
 * section is on screen", so no subprocess spawns while nobody can see it.
 * `refreshNow()` closes the gap when the section or the view opens.
 */
export class SystemMonitor {
  /** Latest completed sample; safe to render from. */
  private _snapshot: SystemSnapshot
  /** `os.cpus()` from the previous sample, the baseline for the next delta. */
  private _previousCpus: os.CpuInfo[]
  /** Last GPU list read from the source (kept when a refresh fails). */
  private _gpus: GpuStats[] = []
  /** Whether `_gpus` came from `nvidia-smi` (live utilization) rather than a name listing. */
  private _gpuLive = false
  /** Whether the GPU source has been probed at least once. */
  private _gpusProbed = false
  private _timer: ReturnType<typeof setInterval> | undefined
  /** Guards against stacking samples while a GPU subprocess is still running. */
  private _sampling = false

  constructor(
    private readonly onUpdate: () => void,
    private readonly gpuEnabled: () => boolean = () => true,
    private readonly intervalMs = SYSTEM_SAMPLE_INTERVAL_MS
  ) {
    // Baseline reading taken now so the first tick already has a delta to
    // report instead of showing an undefined utilization.
    this._previousCpus = os.cpus()
    this._snapshot = this.buildSnapshot(this._previousCpus, undefined)
  }

  /** The most recent sample. */
  get snapshot(): SystemSnapshot {
    return this._snapshot
  }

  /** Whether the GPU source has been probed at least once this session. */
  get gpusProbed(): boolean {
    return this._gpusProbed
  }

  /** Start the sampling timer; a second call does nothing. */
  start(): void {
    if (this._timer !== undefined) return
    this._timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  /** Sample immediately instead of waiting for the next tick (view/section opened). */
  refreshNow(): void {
    void this.tick()
  }

  /** Stop the sampling timer. */
  dispose(): void {
    if (this._timer !== undefined) clearInterval(this._timer)
    this._timer = undefined
  }

  /** One sample: refresh GPUs, update the snapshot, then notify the provider. */
  private async tick(): Promise<void> {
    // A previous tick may still be waiting on a subprocess; skip rather than
    // stack calls, so one slow sample cannot turn into a queue.
    if (this._sampling) return
    this._sampling = true
    try {
      await this.sampleGpus()
      const cpus = os.cpus()
      const usage = cpuUsage(cpus, this._previousCpus)
      this._previousCpus = cpus
      this._snapshot = this.buildSnapshot(cpus, usage)
      this.onUpdate()
    } catch (err) {
      Logger.warn(`System stats sample failed: ${err}`)
    } finally {
      this._sampling = false
    }
  }

  /**
   * Refresh the GPU list from whichever source this machine has. The source is
   * probed once: `nvidia-smi` first (live utilization), then a static OS
   * listing (names only). After that only live sources are re-queried, and
   * only while `gpuEnabled` says the rows are on screen — a failed refresh
   * keeps the last good values rather than blanking the rows.
   */
  private async sampleGpus(): Promise<void> {
    if (!this.gpuEnabled()) return
    if (!this._gpusProbed) {
      this._gpusProbed = true
      const live = await queryNvidiaSmi()
      if (live) {
        this._gpus = live
        this._gpuLive = true
        Logger.info(`System stats: ${live.length} GPU(s) readable via nvidia-smi`)
        return
      }
      this._gpus = await listGpusStatic()
      this._gpuLive = false
      Logger.info(`System stats: nvidia-smi unavailable, listing ${this._gpus.length} GPU(s) without utilization`)
      return
    }
    if (!this._gpuLive) return
    const live = await queryNvidiaSmi()
    if (live) this._gpus = live
  }

  /** Assemble a snapshot from one `os` reading plus the retained GPU list. */
  private buildSnapshot(cpus: os.CpuInfo[], usage: number | undefined): SystemSnapshot {
    const total = os.totalmem()
    const free = os.freemem()
    const first = cpus[0]
    const used = Math.max(total - free, 0)
    return {
      cpu: {
        model: (first?.model ?? '').trim(),
        speed: first?.speed,
        cores: cpus.length,
        usage
      },
      memory: {
        total,
        free,
        used,
        usage: total > 0 ? Math.round((used / total) * 1000) / 10 : 0
      },
      gpus: [...this._gpus],
      gpuLive: this._gpuLive,
      updatedAt: Date.now()
    }
  }
}
