import { TELEMETRY_SEED } from './drainage-seed'
import type { CalibrationRecord, DrainageTelemetry } from './drainage-types'

// 排水领域数据独立持久化：遥测与待校准台账各一份，和清单（entries）一起由 service 同步提交。
const TELEMETRY_KEY = 'urban-utility-tunnel:drainage-telemetry'
const CALIBRATION_KEY = 'urban-utility-tunnel:drainage-calibration'
// 存储结构版本：升级后旧结构整体回种子，避免新字段缺失。
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let telemetryCache: DrainageTelemetry[] | null = null
let calibrationCache: CalibrationRecord[] | null = null

function stampVersion(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem('urban-utility-tunnel:schema-version', String(SCHEMA_VERSION))
  }
}

export function loadTelemetry(): DrainageTelemetry[] {
  if (telemetryCache === null) {
    telemetryCache = readJson(TELEMETRY_KEY, TELEMETRY_SEED)
    stampVersion()
  }
  return telemetryCache
}

export function saveTelemetry(rows: DrainageTelemetry[]): void {
  telemetryCache = rows
  writeJson(TELEMETRY_KEY, rows)
}

export function resetTelemetry(): DrainageTelemetry[] {
  const rows = clone(TELEMETRY_SEED)
  saveTelemetry(rows)
  return rows
}

export function loadCalibration(): CalibrationRecord[] {
  if (calibrationCache === null) {
    calibrationCache = readJson<CalibrationRecord[]>(CALIBRATION_KEY, [])
  }
  return calibrationCache
}

export function saveCalibration(rows: CalibrationRecord[]): void {
  calibrationCache = rows
  writeJson(CALIBRATION_KEY, rows)
}

export function resetCalibration(): CalibrationRecord[] {
  saveCalibration([])
  return []
}

export function calibrationStorageKey(): string {
  return CALIBRATION_KEY
}
