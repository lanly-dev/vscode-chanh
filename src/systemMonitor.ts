import { execFile } from 'child_process'
import * as os from 'os'

import { Logger } from './logger'

/**
 * Default sampling cadence, in milliseconds. `chanh.systemSampleInterval`
 * (seconds) overrides it at runtime.
 */
export const SYSTEM_SAMPLE_INTERVAL_MS = 5000

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
  /** Core utilization 0-100, from `nvidia-smi` or the Windows performance counters. */
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
 * Adapter inventory from the OS: the base list that every live source
 * overlays onto. Windows reads WMI (`Win32_VideoController`) and skips
 * USB-attached display adapters (DisplayLink); Linux reads `lspci`; any
 * other platform resolves to an empty list. Entries start out as names
 * only and gain utilization once a live source matches them.
 */
function listGpusStatic(): Promise<GpuStats[]> {
  if (process.platform === 'win32') {
    const filter = 'Where-Object { $_.PNPDeviceID -and $_.PNPDeviceID -notlike "USB\*" }'
    const script = 'Get-CimInstance -ClassName Win32_VideoController | ' + filter + ' | ForEach-Object { $_.Name }'
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

/** One DXGI adapter as recorded in the session LUID map. */
export interface LuidAdapter {
  /** Display name as DXGI reports it. */
  name: string
  /** Adapter-local (dedicated) memory in bytes; 0 when unknown. */
  dedicated: number
}

/**
 * Normalize a GPU name for cross-source comparison: lowercase letters and
 * digits only, e.g. `Intel(R) UHD Graphics` becomes `inteluhdgraphics`.
 */
export function normalizeGpuName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Vendor words that one source prefixes a card with and another omits. */
const GPU_VENDOR_PREFIXES = [
  'nvidiacorporation', 'nvidia', 'advancedmicrodevicesinc', 'amdati',
  'intelcorporation', 'intel'
]

/**
 * Whether two names from different sources (WMI, `lspci`, DXGI, `nvidia-smi`)
 * describe the same adapter. Tries normalized equality and containment first,
 * then containment again after stripping a vendor word, so
 * `nvidiacorporationga102[geforcertx4090]` still matches `GeForce RTX 4090`.
 */
export function gpuNamesMatch(a: string, b: string): boolean {
  const x = normalizeGpuName(a)
  const y = normalizeGpuName(b)
  if (x === y || x.includes(y) || y.includes(x)) return true
  const strip = (name: string): string => {
    for (const prefix of GPU_VENDOR_PREFIXES) {
      if (name.startsWith(prefix)) return name.slice(prefix.length)
    }
    return name
  }
  const x2 = strip(x)
  const y2 = strip(y)
  return x2 !== '' && y2 !== '' && (x2.includes(y2) || y2.includes(x2))
}

/**
 * C# compiled by PowerShell once per session to list the machine's DXGI
 * adapters as `lowHex|highHex|name|vendorId|dedicatedBytes`. DXGI is the only
 * portable way to map an adapter LUID (what the performance counters are
 * keyed by) to a friendly name.
 */
const DXGI_ADAPTER_LIST_CSHARP = `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ChanhGpuLuid
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DXGI_ADAPTER_DESC1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId;
        public uint DeviceId;
        public uint SubSysId;
        public uint Revision;
        public IntPtr DedicatedVideoMemory;
        public IntPtr DedicatedSystemMemory;
        public IntPtr SharedSystemMemory;
        public LUID AdapterLuid;
        public uint Flags;
    }

    [DllImport("dxgi.dll")]
    private static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);

    private delegate int EnumAdapters1Del(IntPtr self, uint index, out IntPtr adapter);
    private delegate int GetDesc1Del(IntPtr self, out DXGI_ADAPTER_DESC1 desc);
    private delegate int ReleaseDel(IntPtr self);

    public static string[] List()
    {
        var lines = new List<string>();
        Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factory;
        if (CreateDXGIFactory1(ref iid, out factory) != 0 || factory == IntPtr.Zero)
            return lines.ToArray();
        IntPtr vt = Marshal.ReadIntPtr(factory);
        var enumAdapters = (EnumAdapters1Del)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(vt, 12 * IntPtr.Size), typeof(EnumAdapters1Del));
        for (uint i = 0; i < 16; i++)
        {
            IntPtr adapter;
            if (enumAdapters(factory, i, out adapter) != 0 || adapter == IntPtr.Zero)
                break;
            IntPtr avt = Marshal.ReadIntPtr(adapter);
            var getDesc = (GetDesc1Del)Marshal.GetDelegateForFunctionPointer(
                Marshal.ReadIntPtr(avt, 8 * IntPtr.Size), typeof(GetDesc1Del));
            DXGI_ADAPTER_DESC1 d;
            if (getDesc(adapter, out d) == 0)
            {
                lines.Add(string.Format("{0:x8}|{1:x8}|{2}|{3}|{4}",
                    d.AdapterLuid.LowPart, unchecked((uint)d.AdapterLuid.HighPart),
                    d.Description, d.VendorId, (long)d.DedicatedVideoMemory));
            }
            var rel = (ReleaseDel)Marshal.GetDelegateForFunctionPointer(
                Marshal.ReadIntPtr(avt, 2 * IntPtr.Size), typeof(ReleaseDel));
            rel(adapter);
        }
        return lines.ToArray();
    }
}`

/** Compile the C# above in PowerShell and print one adapter per line. */
const DXGI_ADAPTER_LIST_SCRIPT =
  `Add-Type -TypeDefinition @'\n${DXGI_ADAPTER_LIST_CSHARP}\n'@\n` +
  `[ChanhGpuLuid]::List() | ForEach-Object { $_ }`

/**
 * Resolve each adapter LUID to its DXGI display name once per session (LUIDs
 * are stable until reboot), registering both half orderings because the perf
 * counters spell LUIDs `high_low` while DXGI reports `low|high`. DisplayLink
 * devices are skipped - they are already filtered out of the base list and
 * must not reappear through counter rows. Failures yield an empty map, which
 * simply leaves counter rows unresolved.
 */
function queryAdapterLuidMap(): Promise<Map<string, LuidAdapter>> {
  const map = new Map<string, LuidAdapter>()
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DXGI_ADAPTER_LIST_SCRIPT],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          Logger.warn(`DXGI adapter listing failed: ${error.message}`)
          return resolve(map)
        }
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.split('|')
          if (parts.length < 5) continue
          const [low, high, name, , dedicated] = parts
          if (/displaylink/i.test(name)) continue
          const adapter: LuidAdapter = { name, dedicated: Number(dedicated) || 0 }
          map.set(`${low}:${high}`, adapter)
          map.set(`${high}:${low}`, adapter)
        }
        resolve(map)
      }
    )
  })
}

/**
 * PowerShell over the Windows GPU performance counters: engine utilization
 * summed per adapter LUID (clamped to 100 - engine types run concurrently)
 * plus dedicated memory, one `t1_t2|util|dedUsed,dedLimit` line per adapter.
 * An adapter with no engine instances is idle and reports an empty util.
 */
const WINDOWS_GPU_COUNTERS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$util = @{}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object {
  if ($_.Name -match 'luid_0x([0-9a-f]+)_0x([0-9a-f]+)') {
    $key = $Matches[1] + '_' + $Matches[2]
    $u = 0.0
    try { $u = [double]$_.UtilizationPercentage } catch { $u = 0 }
    $v = 0.0
    if ($util.ContainsKey($key)) { $v = $util[$key] }
    $n = $v + $u
    if ($n -gt 100) { $n = 100 }
    $util[$key] = $n
  }
}
$mem = @{}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {
  if ($_.Name -match 'luid_0x([0-9a-f]+)_0x([0-9a-f]+)') {
    $key = $Matches[1] + '_' + $Matches[2]
    $d = [int64]0
    $dl = [int64]0
    if ($null -ne $_.DedicatedUsage) { try { $d = [int64]$_.DedicatedUsage } catch { $d = 0 } }
    if ($null -ne $_.DedicatedLimit) { try { $dl = [int64]$_.DedicatedLimit } catch { $dl = 0 } }
    $mem[$key] = $d.ToString() + ',' + $dl.ToString()
  }
}
$keys = @{}
foreach ($k in $util.Keys) { $keys[$k] = $true }
foreach ($k in $mem.Keys) { $keys[$k] = $true }
foreach ($k in $keys.Keys) {
  $u = ''
  if ($util.ContainsKey($k)) { $u = $util[$k].ToString([cultureinfo]::InvariantCulture) }
  $m = ''
  if ($mem.ContainsKey($k)) { $m = $mem[$k] }
  $k + '|' + $u + '|' + $m
}`

/**
 * Parse the counter script's `t1_t2|util|dedUsed,dedLimit` lines into named
 * `GpuStats`. LUID halves are lowercased (the counters print uppercase hex)
 * and tried in both orderings against the DXGI map, whose key order differs.
 * Unresolvable LUIDs are skipped.
 */
export function parseWindowsCounters(stdout: string, luidMap: Map<string, LuidAdapter>): GpuStats[] {
  const gpus: GpuStats[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts.length < 3) continue
    const halves = parts[0].toLowerCase().split('_')
    if (halves.length !== 2) continue
    const adapter = luidMap.get(`${halves[0]}:${halves[1]}`) ??
      luidMap.get(`${halves[1]}:${halves[0]}`)
    if (!adapter) continue
    // An adapter with no engine instances emits an empty util: that is
    // "unknown", not "idle", so leave usage undefined rather than claim 0.
    if (parts[1].trim() === '') continue
    const usage = Number(parts[1])
    if (!Number.isFinite(usage)) continue
    const stats: GpuStats = { name: adapter.name, usage: Math.min(Math.max(usage, 0), 100) }
    const memory = parts[2].split(',')
    const used = Number(memory[0])
    const limit = Number(memory[1])
    if (Number.isFinite(used) && used >= 0) stats.memoryUsed = used
    const total = adapter.dedicated > 0 ? adapter.dedicated : limit
    if (Number.isFinite(total) && total > 0) stats.memoryTotal = total
    gpus.push(stats)
  }
  return gpus
}

/**
 * One PowerShell run over the Windows GPU performance counters, parsed into
 * named `GpuStats`. Resolves [] on failure (older Windows without the counter
 * classes) so rows simply keep what they had.
 */
function queryWindowsGpuCounters(luidMap: Map<string, LuidAdapter>): Promise<GpuStats[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_GPU_COUNTERS_SCRIPT],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' },
      (error, stdout) => resolve(error ? [] : parseWindowsCounters(stdout, luidMap))
    )
  })
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
  /** Working GPU list: the OS adapter inventory overlaid with live stats (kept when a refresh fails). */
  private _gpus: GpuStats[] = []
  /** DXGI adapter LUID mapped to name and memory, resolved once per session (Windows). */
  private _luidMap: Map<string, LuidAdapter> = new Map()
  /** Whether any adapter needs the Windows performance counters (non-NVIDIA GPUs). */
  private _countersWanted = false
  /** Whether the GPU source has been probed at least once. */
  private _gpusProbed = false
  private _timer: ReturnType<typeof setInterval> | undefined
  /** Guards against stacking samples while a GPU subprocess is still running. */
  private _sampling = false

  constructor(
    private readonly onUpdate: () => void,
    private readonly gpuEnabled: () => boolean = () => true,
    private intervalMs = SYSTEM_SAMPLE_INTERVAL_MS
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

  /** Change the sampling cadence; restarts a running timer on the new interval. */
  setIntervalMs(intervalMs: number): void {
    if (this.intervalMs === intervalMs) return
    this.intervalMs = intervalMs
    if (this._timer !== undefined) {
      clearInterval(this._timer)
      this._timer = undefined
      this.start()
    }
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
   * Refresh the GPU rows from every source this machine has. The base list of
   * adapters comes from a one-time OS probe; live sources - the Windows GPU
   * performance counters (integrated / non-NVIDIA) and `nvidia-smi` (NVIDIA)
   * - overlay their values onto it by name, so a mixed-vendor machine shows
   * every adapter with whatever each source can read. A failed query keeps
   * the last good values rather than blanking the rows. Runs only while
   * `gpuEnabled` says the rows are on screen.
   */
  private async sampleGpus(): Promise<void> {
    if (!this.gpuEnabled()) return
    if (!this._gpusProbed) {
      this._gpus = await listGpusStatic()
      if (process.platform === 'win32') {
        this._luidMap = await queryAdapterLuidMap()
        this._countersWanted = this._gpus.length === 0 ||
          this._gpus.some((gpu) => !normalizeGpuName(gpu.name).startsWith('nvidia'))
      }
      this._gpusProbed = true
      Logger.info(`System stats: listed ${this._gpus.length} GPU adapter(s)`)
    }
    const countersWanted = process.platform === 'win32' &&
      (this._countersWanted || this._gpus.some((gpu) => gpu.usage === undefined))
    if (countersWanted) {
      const counters = await queryWindowsGpuCounters(this._luidMap)
      this.overlayLive(counters, this._gpus.length === 0)
    }
    const nvidia = await queryNvidiaSmi()
    if (nvidia) this.overlayLive(nvidia, true)
  }

  /**
   * Attach live stats to the working list. Matched rows only overwrite fields
   * the source actually reports; unmatched entries are appended only when
   * `append` is set - the counters stay match-only so adapters the OS listing
   * filtered out (DisplayLink) cannot sneak back in through them.
   */
  private overlayLive(entries: GpuStats[], append: boolean): void {
    for (const entry of entries) {
      const row = this._gpus.find((gpu) => gpuNamesMatch(gpu.name, entry.name))
      if (!row) {
        if (append) this._gpus.push(entry)
        continue
      }
      row.usage = entry.usage ?? row.usage
      row.memoryUsed = entry.memoryUsed ?? row.memoryUsed
      row.memoryTotal = entry.memoryTotal ?? row.memoryTotal
      row.temperature = entry.temperature ?? row.temperature
    }
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
      updatedAt: Date.now()
    }
  }
}
