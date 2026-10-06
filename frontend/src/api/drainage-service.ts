/**
 * 排水泵坑水位领域服务：页面/设备入口都只通过这里读写排水数据。
 *
 * 设计要点：
 * 1. 判读水位 resolvedLevel: number | null —— null 是缺测，绝不按 0 参与启泵/正常判定；0 是合法实测干涸。
 * 2. 两路读数冲突时以现场实测为准，液位计读数留档标「未采信」，所有结论按实测值回算。
 * 3. 清单行、设备台账行、待校准台账与遥测在 commit() 内同步落库，任何入口看到的读数一致。
 * 4. 同一液位计的待校准台账按液位计编号去重，重复上报只记一次。
 */
import { listRows, saveRows } from '@/data/local-store'
import {
  loadCalibration,
  loadTelemetry,
  resetCalibration,
  resetTelemetry,
  saveCalibration,
  saveTelemetry,
} from '@/data/drainage-store'
import type {
  CalibrationRecord,
  DrainageTelemetry,
  MigrationBatchInfo,
  PitView,
} from '@/data/drainage-types'
import type { ActionResult, EntryRow } from '@/data/types'

const FAIL_THRESHOLD = 3 // 连续取不到第 3 次才提示去现场核、挂待校准
const CONFLICT_TOLERANCE = 0.3 // 两路读数差超过 0.3m 视为冲突，以现场实测为准

const DEFAULT_UNIT = '管廊运维一所'

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : null
}

/** 连续失败达到阈值：提示去现场核对。 */
export function failThreshold(): number {
  return FAIL_THRESHOLD
}

function findPit(rows: DrainageTelemetry[], id: number): DrainageTelemetry | undefined {
  return rows.find((item) => item.pitId === id)
}

// —— 越界校验 ——

function configOutOfRange(t: DrainageTelemetry): { hit: boolean; text: string } {
  if (t.capacity === null || t.pumpOnLevel === null) {
    return { hit: false, text: '' }
  }
  if (t.capacity <= 0) {
    return { hit: true, text: `集水坑容积配置无效（${t.capacity}m³），须大于 0` }
  }
  if (t.pumpOnLevel < 0) {
    return { hit: true, text: `启泵水位不能为负（${t.pumpOnLevel}m）` }
  }
  if (t.pumpOnLevel > t.capacity) {
    return {
      hit: true,
      text: `启泵水位 ${t.pumpOnLevel}m 大于集水坑容积上限 ${t.capacity}m³，阈值配置越界`,
    }
  }
  return { hit: false, text: '' }
}

function readingOutOfRange(t: DrainageTelemetry, level: number | null): boolean {
  if (level === null) return false
  if (level < 0) return true
  if (t.capacity !== null && level > t.capacity) return true
  return false
}

// —— 仲裁 ——

interface AdoptResult {
  resolved: number | null
  adopted: DrainageTelemetry['adopted']
  conflict: boolean
  conflictText: string
  gaugeOutOfRange: boolean
}

function adopt(t: DrainageTelemetry): AdoptResult {
  // 液位计一路：存量疑似断线记 0 在迁移前先按缺测处理，0 不能冒充读数
  const rawGauge = t.legacy && t.legacyZero && !t.migratedBatch ? null : t.gaugeLevel
  const gaugeValid = t.gaugeOk && rawGauge !== null
  const gauge = gaugeValid ? (rawGauge as number) : null
  const gaugeOutOfRange = gaugeValid && readingOutOfRange(t, gauge)

  const manual = t.manualLevel

  // 仲裁规则：两路都有效且差值超阈值，现场实测是直接量、液位计是可能漂移的间接量，一律以实测为准。
  if (manual !== null) {
    const conflict = gauge !== null && Math.abs(manual - gauge) > CONFLICT_TOLERANCE
    const conflictText = conflict
      ? `液位计 ${gauge?.toFixed(2)}m 与现场实测 ${manual.toFixed(2)}m 相差 ${Math.abs(manual - (gauge ?? 0)).toFixed(2)}m，按现场实测统一，液位计读数留档未采信`
      : ''
    return { resolved: manual, adopted: 'manual', conflict, conflictText, gaugeOutOfRange }
  }
  if (gauge !== null && !gaugeOutOfRange) {
    return { resolved: gauge, adopted: 'gauge', conflict: false, conflictText: '', gaugeOutOfRange: false }
  }
  // 液位计读数本身越界：不当 0、不采信，按缺测并说明
  return { resolved: null, adopted: null, conflict: false, conflictText: '', gaugeOutOfRange }
}

function missingReason(t: DrainageTelemetry, outOfRange: boolean): string {
  if (t.legacy) {
    const cutoff = t.inspectDate || '巡检日期缺失'
    if (t.legacyZero && !t.migratedBatch) {
      return `疑似早年断线被记为 0（无干涸巡检背书），上线前数据不予采信；存量按上次巡检日期回填，数据截止 ${cutoff}`
    }
    if (t.migratedBatch) {
      return `存量泵坑缺数，按上次巡检日期回填，数据截止 ${cutoff}；已随 ${t.migratedBatch} 批次迁移并在备注登记出处`
    }
  }
  if (outOfRange) return `液位计读数超出物理量程，未采信；原因：连续取数失败 ${t.consecutiveFails} 次（${t.failReason || '未应答'}）`
  if (!t.gaugeOk && t.failReason) {
    return `液位计取数失败：${t.failReason}，已连续 ${t.consecutiveFails} 次取不到`
  }
  if (!t.gaugeOk) return `液位计取数失败，已连续 ${t.consecutiveFails} 次取不到`
  return '两路取值均无有效读数，暂无数据'
}

// —— 待校准台账（去重挂账） ——

function openRecord(rows: CalibrationRecord[], gaugeDeviceId: string): CalibrationRecord | undefined {
  return rows.find((item) => item.gaugeDeviceId === gaugeDeviceId && item.state === '待校准')
}

function upsertCalibration(
  rows: CalibrationRecord[],
  patch: Omit<CalibrationRecord, 'id' | 'openedAt' | 'state' | 'calibratedAt'> & { batch?: string | null },
): { list: CalibrationRecord[]; created: boolean } {
  const existing = openRecord(rows, patch.gaugeDeviceId)
  if (existing) {
    existing.reason = patch.reason
    existing.consecutiveFails = patch.consecutiveFails
    existing.basis = patch.basis
    if (patch.batch !== undefined) existing.batch = patch.batch
    return { list: rows, created: false }
  }
  const id = rows.reduce((max, item) => Math.max(max, item.id), 0) + 1
  rows.push({
    id,
    gaugeDeviceId: patch.gaugeDeviceId,
    pitId: patch.pitId,
    pitCode: patch.pitCode,
    ownerUnit: patch.ownerUnit,
    reason: patch.reason,
    openedAt: nowText(),
    state: '待校准',
    consecutiveFails: patch.consecutiveFails,
    calibratedAt: null,
    basis: patch.basis,
    batch: patch.batch ?? null,
  })
  return { list: rows, created: true }
}

// —— 回算 ——

function pitCodeMap(): Map<number, EntryRow> {
  const map = new Map<number, EntryRow>()
  for (const row of listRows('drainage')) {
    map.set(Number(row.id), row)
  }
  return map
}

function deriveStatus(t: DrainageTelemetry, view: { resolved: number | null; oor: boolean }): string {
  if (t.pumpState === '水泵故障') return '水泵故障'
  if (view.resolved === null) return '数据缺测'
  if (t.pumpState === '排水中') return '排水中'
  if (t.pumpOnLevel !== null && view.resolved >= t.pumpOnLevel) return '待排水'
  return '水位正常'
}

function buildView(
  t: DrainageTelemetry,
  entry: EntryRow | undefined,
  records: CalibrationRecord[],
): PitView {
  const adoptedRes = adopt(t)
  const oor = configOutOfRange(t)
  const status = deriveStatus(t, { resolved: adoptedRes.resolved, oor: oor.hit })
  const missing = adoptedRes.resolved === null
  const escalated = t.consecutiveFails >= FAIL_THRESHOLD && !t.gaugeOk
  const rec = openRecord(records, t.gaugeDeviceId) ?? null
  const gaugeLevel = t.legacy && t.legacyZero && !t.migratedBatch ? null : t.gaugeLevel

  return {
    pitId: t.pitId,
    code: String(entry?.['泵坑编号'] ?? `DRAI-${String(t.pitId).padStart(4, '0')}`),
    cabin: String(entry?.['所属舱室'] ?? ''),
    ownerUnit: t.ownerUnit,
    pumpNo: String(entry?.['排水泵编号'] ?? ''),
    duty: String(entry?.['值班人员'] ?? ''),
    gaugeDeviceId: t.gaugeDeviceId,
    capacity: t.capacity,
    pumpOnLevel: t.pumpOnLevel,
    pumpState: t.pumpState,
    gaugeLevel,
    gaugeOk: !(t.legacy && t.legacyZero && !t.migratedBatch) && t.gaugeOk,
    gaugeAdopted: adoptedRes.adopted === 'gauge',
    failReason: t.failReason,
    fails: t.consecutiveFails,
    lastFetchAt: t.lastFetchAt,
    escalated,
    manualLevel: t.manualLevel,
    manualAt: t.manualAt,
    manualBy: t.manualBy,
    resolvedLevel: adoptedRes.resolved,
    adopted: adoptedRes.adopted,
    conflict: adoptedRes.conflict,
    conflictText: adoptedRes.conflictText,
    outOfRange: oor.hit,
    outOfRangeText: oor.text,
    readingOutOfRange: adoptedRes.gaugeOutOfRange,
    missing,
    reason: missing ? missingReason(t, adoptedRes.gaugeOutOfRange) : '',
    legacy: t.legacy,
    legacyZero: t.legacyZero,
    dataMonth: t.dataMonth,
    migratedBatch: t.migratedBatch,
    migrationNote: t.migrationNote,
    inspectDate: t.inspectDate,
    status,
    abnormal:
      missing ||
      oor.hit ||
      adoptedRes.conflict ||
      adoptedRes.gaugeOutOfRange ||
      t.pumpState === '水泵故障' ||
      rec !== null,
    openCalibration: rec,
  }
}

// —— 同步清单与设备台账（两处不能各算各的） ——

function syncEntryRows(views: PitView[]): EntryRow[] {
  const byId = new Map(views.map((v) => [v.pitId, v]))
  return listRows('drainage').map((row) => {
    const v = byId.get(Number(row.id))
    if (!v) return row
    return {
      ...row,
      status: v.status,
      pending: v.status === '待排水' || v.status === '排水中',
      abnormal: v.abnormal,
      当前水位: v.resolvedLevel === null ? '' : v.resolvedLevel,
      液位计读数: v.gaugeLevel === null ? '' : v.gaugeLevel,
      现场实测水位: v.manualLevel === null ? '' : v.manualLevel,
      取值说明: v.missing
        ? v.reason
        : v.conflict
          ? v.conflictText
          : v.outOfRange
            ? v.outOfRangeText
            : v.adopted === 'manual'
              ? '按现场实测取值'
              : '',
      数据状态: v.missing
        ? '缺测'
        : v.outOfRange
          ? '配置越界'
          : v.conflict
            ? '两路冲突·采信实测'
            : '正常',
      所属单位: v.ownerUnit,
      上次巡检日期: v.inspectDate,
      液位计编号: v.gaugeDeviceId,
      待校准: v.openCalibration ? '是' : '',
      迁移批次: v.migratedBatch ?? '',
      备注: v.migrationNote,
    } as EntryRow
  })
}

function syncDeviceRows(records: CalibrationRecord[]): EntryRow[] {
  const openByGauge = new Map(
    records.filter((r) => r.state === '待校准').map((r) => [r.gaugeDeviceId, r]),
  )
  return listRows('device').map((row) => {
    const rec = openByGauge.get(String(row['设备编号']))
    if (!rec) {
      // 已校准销项的液位计恢复运行态，保证设备台账与校准台账始终一致
      const isGauge = String(row['设备型号']) === '投入式液位计'
      return isGauge
        ? ({
            ...row,
            status: '运行中',
            pending: true,
            abnormal: false,
            设备状态: '运行中',
            待校准原因: '',
            关联泵坑: '',
            台账批次: '',
            校准依据: '',
          } as EntryRow)
        : row
    }
    return {
      ...row,
      status: '待校准',
      pending: true,
      abnormal: true,
      设备状态: '待校准',
      保养周期: '按校准工单',
      上次保养日: rec.openedAt.slice(0, 10),
      待校准原因: rec.reason,
      关联泵坑: rec.pitCode,
      台账批次: rec.batch ?? '',
      校准依据: rec.basis,
    } as EntryRow
  })
}

interface CommitInput {
  telemetry: DrainageTelemetry[]
  calibration: CalibrationRecord[]
}

function commit(input: CommitInput): void {
  // 先回算视图，再用视图同步清单和设备台账：四处写入在一次提交里完成。
  const entries = pitCodeMap()
  const views = input.telemetry.map((t) =>
    buildView(t, entries.get(t.pitId), input.calibration),
  )
  saveTelemetry(input.telemetry)
  saveCalibration(input.calibration)
  saveRows('drainage', syncEntryRows(views))
  saveRows('device', syncDeviceRows(input.calibration))
}

/** 首次进入/任何入口读取前：回算结论并把台账与清单对齐（幂等）。 */
export function reconcileDrainage(): PitView[] {
  const telemetry = loadTelemetry()
  const calibration = loadCalibration()
  const entries = pitCodeMap()
  for (const t of telemetry) {
    const code = String(entries.get(t.pitId)?.['泵坑编号'] ?? '')
    // 连续失败达阈值：挂账（按液位计编号去重，重复上报只记一次）
    if (!t.gaugeOk && t.consecutiveFails >= FAIL_THRESHOLD) {
      upsertCalibration(calibration, {
        gaugeDeviceId: t.gaugeDeviceId,
        pitId: t.pitId,
        pitCode: code,
        ownerUnit: t.ownerUnit,
        reason: `液位计连续 ${t.consecutiveFails} 次取数失败（${t.failReason || 'RTU 无应答'}），需现场核查`,
        consecutiveFails: t.consecutiveFails,
        basis: `取数失败于 ${t.lastFetchAt ?? '时间未知'}，连续 ${t.consecutiveFails} 次未恢复`,
        batch: null,
      })
    }
    // 两路冲突：液位计也列待校准（实测先兜底运行，仪表仍要校核）
    const a = adopt(t)
    if (a.conflict) {
      upsertCalibration(calibration, {
        gaugeDeviceId: t.gaugeDeviceId,
        pitId: t.pitId,
        pitCode: code,
        ownerUnit: t.ownerUnit,
        reason: `液位计读数与现场实测冲突（差 ${(t.manualLevel !== null && t.gaugeLevel !== null ? Math.abs(t.manualLevel - t.gaugeLevel) : 0).toFixed(2)}m）`,
        consecutiveFails: t.consecutiveFails,
        basis: a.conflictText,
        batch: null,
      })
    }
    // 存量疑似断线记 0：不预先挂账，避免与月份迁移批次重复；执行迁移时统一挂账。
  }

  commit({ telemetry, calibration })
  return telemetry.map((t) => buildView(t, entries.get(t.pitId), calibration))
}

export function listPitViews(): PitView[] {
  return reconcileDrainage()
}

export function getPitView(id: number): PitView | undefined {
  return listPitViews().find((v) => v.pitId === id)
}

export function listCalibration(state?: '待校准' | '已校准'): CalibrationRecord[] {
  const rows = loadCalibration()
  return state ? rows.filter((r) => r.state === state) : rows
}

// —— 归属校验：归属之外的操作一律拒绝 ——

function ensureOwner(t: DrainageTelemetry | undefined, unit: string): ActionResult | null {
  if (!t) return { ok: false, message: '没有找到该泵坑' }
  if (unit !== t.ownerUnit) {
    return {
      ok: false,
      message: `跨单位代提交已拦截：当前账号归属「${unit}」，该泵坑归属「${t.ownerUnit}」，归属之外的操作一律拒绝`,
    }
  }
  return null
}

// —— 重试取数 ——

export interface DrainageMutation {
  ok: boolean
  message: string
  view?: PitView
}

export function retryFetch(id: number, unit: string): DrainageMutation {
  const telemetry = loadTelemetry()
  const calibration = loadCalibration()
  const t = findPit(telemetry, id)
  const denied = ensureOwner(t, unit)
  if (denied) return denied

  const pit = t as DrainageTelemetry
  pit.lastFetchAt = nowText()

  if (pit.gaugeHealthy) {
    // 重新取一次：仪表在线即恢复，空态解除
    pit.gaugeOk = true
    pit.gaugeLevel = pit.simulatedLevel
    pit.consecutiveFails = 0
    pit.failReason = ''
    commit({ telemetry, calibration })
    return {
      ok: true,
      message: `重新取数成功：当前水位 ${pit.simulatedLevel.toFixed(2)}m（${pit.lastFetchAt}）`,
      view: getPitView(id),
    }
  }

  pit.gaugeOk = false
  pit.gaugeLevel = null
  pit.consecutiveFails += 1
  const entries = pitCodeMap()
  const code = String(entries.get(id)?.['泵坑编号'] ?? '')
  let message = `第 ${pit.consecutiveFails} 次重新取数仍失败（${pit.failReason || 'RTU 无应答'}），当前水位留空、未按 0 判定`
  if (pit.consecutiveFails >= FAIL_THRESHOLD) {
    const { created } = upsertCalibration(calibration, {
      gaugeDeviceId: pit.gaugeDeviceId,
      pitId: id,
      pitCode: code,
      ownerUnit: pit.ownerUnit,
      reason: `液位计连续 ${pit.consecutiveFails} 次取数失败（${pit.failReason || 'RTU 无应答'}），需现场核查`,
      consecutiveFails: pit.consecutiveFails,
      basis: `第 ${pit.consecutiveFails} 次重试仍失败于 ${pit.lastFetchAt}`,
      batch: null,
    })
    message += `；已连续 ${FAIL_THRESHOLD} 次取不到，请去现场核对，液位计 ${pit.gaugeDeviceId}${created ? '已' : '已在'}列入设备侧待校准台账`
  } else {
    message += `；可继续重试，连续 ${FAIL_THRESHOLD} 次取不到再提示去现场核`
  }
  commit({ telemetry, calibration })
  return { ok: true, message, view: getPitView(id) }
}

// —— 现场实测上报 ——

export function submitManualLevel(
  id: number,
  rawLevel: string,
  operator: string,
  unit: string,
): DrainageMutation {
  const level = toNumber(rawLevel)
  const telemetry = loadTelemetry()
  const calibration = loadCalibration()
  const t = findPit(telemetry, id)
  const denied = ensureOwner(t, unit)
  if (denied) return denied
  if (level === null) {
    return { ok: false, message: '现场实测水位必须是数字；若确实干涸请填 0，缺测请留空而不是填 0' }
  }
  const pit = t as DrainageTelemetry
  if (level < 0 || (pit.capacity !== null && level > pit.capacity)) {
    const limit = pit.capacity === null ? '0 以上' : `0 ~ ${pit.capacity}m³`
    return { ok: false, message: `读数越界：实测 ${level}m 超出物理量程（${limit}），请现场复核后重报` }
  }

  pit.manualLevel = level
  pit.manualAt = nowText()
  pit.manualBy = operator
  const entries = pitCodeMap()
  const code = String(entries.get(id)?.['泵坑编号'] ?? '')
  const a = adopt(pit)
  let message = `现场实测 ${level}m 已登记`
  if (level === 0) message += '（0 米为实测干涸，与缺测严格区分）'

  if (a.conflict) {
    upsertCalibration(calibration, {
      gaugeDeviceId: pit.gaugeDeviceId,
      pitId: id,
      pitCode: code,
      ownerUnit: pit.ownerUnit,
      reason: `液位计读数与现场实测冲突（差 ${(pit.gaugeLevel !== null ? Math.abs(level - pit.gaugeLevel) : 0).toFixed(2)}m）`,
      consecutiveFails: pit.consecutiveFails,
      basis: a.conflictText,
      batch: null,
    })
    message += `；${a.conflictText}`
  } else if (pit.gaugeLevel !== null) {
    message += '，与液位计读数一致'
  }
  message += '；清单与设备台账已按实测值同步回算'
  commit({ telemetry, calibration })
  return { ok: true, message, view: getPitView(id) }
}

// —— 校准液位计 ——

export function calibrateGauge(
  id: number,
  operator: string,
  unit: string,
  fieldLevelRaw?: string,
): DrainageMutation {
  const telemetry = loadTelemetry()
  const calibration = loadCalibration()
  const t = findPit(telemetry, id)
  const denied = ensureOwner(t, unit)
  if (denied) return denied
  const pit = t as DrainageTelemetry
  const rec = openRecord(calibration, pit.gaugeDeviceId)
  if (!rec) {
    return { ok: false, message: '该液位计没有待校准记录，无需校准' }
  }

  // 现场校准必须带回实测基准；没有实测记录则要求当场录入
  let basisLevel = pit.manualLevel
  if (fieldLevelRaw !== undefined && fieldLevelRaw.trim() !== '') {
    const n = toNumber(fieldLevelRaw)
    if (n === null || n < 0 || (pit.capacity !== null && n > pit.capacity)) {
      return { ok: false, message: '校准基准值越界，请填写 0 到集水坑容积之间的实测米数' }
    }
    basisLevel = n
    pit.manualLevel = n
    pit.manualAt = nowText()
    pit.manualBy = operator
  }
  if (basisLevel === null) {
    return { ok: false, message: '校准则需现场实测基准值，请先登记一次现场实测水位（干涸可填 0）' }
  }

  pit.gaugeHealthy = true
  pit.gaugeOk = true
  pit.simulatedLevel = basisLevel
  pit.gaugeLevel = basisLevel
  pit.consecutiveFails = 0
  pit.failReason = ''
  pit.lastFetchAt = nowText()
  rec.state = '已校准'
  rec.calibratedAt = nowText()
  rec.basis += `；${rec.calibratedAt} 由 ${operator} 现场校准，基准 ${basisLevel}m，两路读数已一致`
  commit({ telemetry, calibration })
  return {
    ok: true,
    message: `液位计 ${pit.gaugeDeviceId} 已按现场实测 ${basisLevel}m 校准并从待校准台账销项，两边读数一致`,
    view: getPitView(id),
  }
}

// —— 泵组操作（数据缺测时禁止启泵，避免按 0 误判） ——

export function setPumpState(
  id: number,
  next: DrainageTelemetry['pumpState'],
  unit: string,
): DrainageMutation {
  const telemetry = loadTelemetry()
  const calibration = loadCalibration()
  const t = findPit(telemetry, id)
  const denied = ensureOwner(t, unit)
  if (denied) return denied
  const pit = t as DrainageTelemetry
  if (next === '排水中') {
    const v = buildView(pit, pitCodeMap().get(id), calibration)
    if (v.resolvedLevel === null) {
      return { ok: false, message: '当前水位缺测，禁止按 0 误判启泵；请重试取数或登记现场实测后再启动' }
    }
  }
  pit.pumpState = next
  commit({ telemetry, calibration })
  return { ok: true, message: `泵组状态已切为「${next}」`, view: getPitView(id) }
}

// —— 存量按月份分批迁移 ——

export function migrationBatches(): MigrationBatchInfo[] {
  const telemetry = loadTelemetry()
  const legacy = telemetry.filter((t) => t.legacy && t.dataMonth)
  const months = [...new Set(legacy.map((t) => t.dataMonth as string))].sort()
  return months.map((month) => {
    const rows = legacy.filter((t) => t.dataMonth === month)
    return {
      month,
      total: rows.length,
      migrated: rows.filter((t) => t.migratedBatch === month).length,
      suspectZero: rows.filter((t) => t.legacyZero && t.migratedBatch !== month).length,
      unverifiable: rows.filter(
        (t) => !t.inspectDate && t.migratedBatch !== month && !t.legacyZero,
      ).length,
      genuineZero: rows.filter(
        (t) => !t.legacyZero && t.gaugeLevel === 0 && t.migratedBatch !== month,
      ).length,
      normalCount: rows.filter(
        (t) =>
          !t.legacyZero &&
          t.gaugeLevel !== 0 &&
          t.inspectDate &&
          t.migratedBatch !== month,
      ).length,
    }
  })
}

export function migrateMonth(month: string): DrainageMutation {
  const telemetry = loadTelemetry()
  const calibration = loadCalibration()
  const entries = pitCodeMap()
  const rows = telemetry.filter((t) => t.legacy && t.dataMonth === month && t.migratedBatch !== month)
  if (!rows.length) return { ok: false, message: `${month} 没有待迁移的存量泵坑` }

  for (const pit of rows) {
    const code = String(entries.get(pit.pitId)?.['泵坑编号'] ?? '')
    if (pit.legacyZero) {
      // 早年断线记 0：剔除为缺测，绝不继续当 0
      pit.gaugeLevel = null
      pit.gaugeOk = false
      pit.failReason = '上线前断线数据曾被记为 0，迁移时按缺测剔除'
      pit.migrationNote = `${pit.migrationNote}；${month} 批次迁移：识别为疑似断线补 0，原 0 值剔除为缺测，待现场复测`
      upsertCalibration(calibration, {
        gaugeDeviceId: pit.gaugeDeviceId,
        pitId: pit.pitId,
        pitCode: code,
        ownerUnit: pit.ownerUnit,
        reason: '上线前液位计断线数据曾被记为 0，迁移识别后需现场复测校准',
        consecutiveFails: pit.consecutiveFails,
        basis: `${month} 批次迁移识别：无干涸巡检背书且当月存在启泵记录，原 0 值不予采信`,
        batch: month,
      })
    } else if (!pit.inspectDate) {
      pit.migrationNote = `${pit.migrationNote}；${month} 批次迁移：巡检日期缺失、出处不可考，读数留待人工现场补录`
    } else {
      pit.migrationNote = `${pit.migrationNote}；${month} 批次迁移：按上次巡检日期 ${pit.inspectDate} 回填，出处已在备注登记`
    }
    pit.migratedBatch = month
  }
  commit({ telemetry, calibration })
  return {
    ok: true,
    message: `${month} 批次已迁移 ${rows.length} 个存量泵坑：疑似断线 0 值已剔除为缺测，缺项出处写入备注，液位计挂入待校准台账`,
  }
}

export function resetDrainageDomain(): void {
  resetTelemetry()
  resetCalibration()
  reconcileDrainage()
}

export function defaultUnit(): string {
  return DEFAULT_UNIT
}
