import { reactive, computed } from 'vue'

import { saveRows, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  adoptReading,
  classifyLegacyZero,
  deriveStatus,
  FIELD_VISIT_THRESHOLD,
  gaugeCodeOf,
  gaugeDeviceId,
  isLevelOutOfRange,
  latestMeasuredInspection,
  parseLevel,
  reconcileLedger,
} from './rules'
import { buildInitialState } from './seed'
import type {
  AnomalyKind,
  DrainagePit,
  DrainageState,
  GaugeReading,
  LedgerItem,
  OwnerUnit,
} from './types'

const STORAGE_KEY = 'urban-utility-tunnel:drainage-domain:v1'

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function load(): DrainageState {
  const fallback = buildInitialState()
  if (typeof window === 'undefined' || !window.localStorage) return fallback
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as DrainageState
    if (parsed.version !== fallback.version) return fallback
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

const state = reactive<DrainageState>(load())

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

/** 归属校验：归属之外的单位一律拒绝（跨单位代提交直接挡回）。 */
function assertOwner(pit: DrainagePit, actorUnit: OwnerUnit, action: string): string | null {
  if (pit.ownerUnit !== actorUnit) {
    return `已挡回：${pit.code} 归属${pit.ownerUnit}，${actorUnit}无权${action}（跨单位代提交一律拒绝）`
  }
  return null
}

export interface ActionOutcome {
  ok: boolean
  message: string
}

/** 液位计镜像写入设备台账：与泵坑清单、待查台账同一事务落盘，
 * 两处读数永远来自同一套仲裁结果，不各算各的。 */
function mirrorGaugesToDevice(): void {
  const deviceRows = listRows('device').map((row) => ({ ...row }))
  const keepIds = new Set(state.pits.map((pit) => gaugeDeviceId(pit.id)))
  const retained = deviceRows.filter((row) => !keepIds.has(Number(row.id)))

  for (const pit of state.pits) {
    const adopted = adoptReading(pit)
    const openKinds = new Set(
      state.ledger
        .filter((item) => item.pitId === pit.id && item.resolvedAt === null)
        .map((item) => item.kind),
    )
    const pendingCalibration =
      openKinds.has('两路不一致') ||
      openKinds.has('读数越界') ||
      openKinds.has('疑似断线置零')
    retained.push({
      id: gaugeDeviceId(pit.id),
      status: pendingCalibration ? '待校准' : '运行中',
      pending: pendingCalibration,
      abnormal: pendingCalibration,
      设备编号: gaugeCodeOf(pit),
      设备名称: `${pit.code} 液位计`,
      设备型号: '投入式液位计',
      所属舱室: pit.cabin,
      投运日期: '存量迁移'.includes(pit.source) ? pit.lastInspectionDate : '2025-06-01',
      保养周期: '12 个月',
      上次保养日: pit.lastInspectionDate,
      设备状态: pendingCalibration ? '待校准' : '运行中',
      归属单位: pit.ownerUnit,
      关联泵坑: pit.code,
      当前读数: adopted.value === null ? '暂无' : `${adopted.value.toFixed(2)} m`,
      校准结论: pendingCalibration ? [...openKinds].join('、') : '两路一致',
    } satisfies EntryRow)
  }
  saveRows('device', retained)
}

/** 统一提交：对账台账 → 持久化排水域 → 镜像设备台账，一次事务完成。 */
function commit(): void {
  const ts = nowText()
  let ledger = state.ledger.map((item) => ({ ...item }))
  for (const pit of state.pits) {
    ledger = reconcileLedger(pit, ledger, adoptReading(pit), ts)
  }
  let nextId = state.nextLedgerId
  for (const item of ledger) {
    if (item.id === -1) {
      item.id = nextId++
    }
  }
  state.ledger = ledger
  state.nextLedgerId = nextId
  persist()
  mirrorGaugesToDevice()
}

// ---- 查询视图 ----

export interface PitView {
  pit: DrainagePit
  adopted: ReturnType<typeof adoptReading>
  status: ReturnType<typeof deriveStatus>
  openLedger: LedgerItem[]
  needFieldVisit: boolean
}

function viewOf(pit: DrainagePit): PitView {
  const adopted = adoptReading(pit)
  return {
    pit,
    adopted,
    status: deriveStatus(pit, adopted),
    openLedger: state.ledger.filter((item) => item.pitId === pit.id && item.resolvedAt === null),
    needFieldVisit: pit.failCount >= FIELD_VISIT_THRESHOLD,
  }
}

export const pitViews = computed<PitView[]>(() =>
  [...state.pits]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(viewOf),
)

export function openLedgerOf(pitId: number): LedgerItem[] {
  return state.ledger
    .filter((item) => item.pitId === pitId && item.resolvedAt === null)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
}

export const pendingCalibrationGauges = computed(() =>
  state.ledger.filter(
    (item) =>
      item.resolvedAt === null &&
      ['两路不一致', '读数越界', '疑似断线置零'].includes(item.kind),
  ),
)

export const allLedgerItems = computed<LedgerItem[]>(() =>
  [...state.ledger].sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
)

// ---- 取数重试（模拟液位计通道） ----

function pollChannel(pit: DrainagePit): GaugeReading {
  const ts = nowText()
  if (pit.channel === 'offline') {
    return { value: null, at: ts, state: 'missing', reason: '液位计通信超时，通道仍未恢复' }
  }
  if (pit.channel === 'flaky') {
    // 连续第 3 次取数时通道恢复；前两次继续失败
    if (pit.failCount + 1 < FIELD_VISIT_THRESHOLD) {
      return { value: null, at: ts, state: 'missing', reason: '液位计响应超时，通道抖动' }
    }
    return { value: pit.mockOnlineLevel, at: ts, state: 'ok', reason: '' }
  }
  return { value: pit.mockOnlineLevel, at: ts, state: 'ok', reason: '' }
}

/** 重试入口：重新取一次。前两次失败只保留重试；第三次起提示去现场核。 */
export function retryFetch(pitId: number, actorUnit: OwnerUnit): ActionOutcome {
  const pit = state.pits.find((p) => p.id === pitId)
  if (!pit) return { ok: false, message: '没有找到该泵坑' }
  const denied = assertOwner(pit, actorUnit, '重试取数')
  if (denied) return { ok: false, message: denied }

  const reading = pollChannel(pit)
  pit.telemetry = reading
  if (reading.state === 'ok') {
    pit.failCount = 0
    commit()
    return { ok: true, message: `取数恢复：当前水位 ${reading.value?.toFixed(2)} m` }
  }
  pit.failCount += 1
  commit()
  if (pit.failCount >= FIELD_VISIT_THRESHOLD) {
    return {
      ok: false,
      message: `已连续 ${pit.failCount} 次取不到水位，请安排人员到现场核验液位计并手动录入读数`,
    }
  }
  return { ok: false, message: `第 ${pit.failCount} 次取数失败，可继续重试（连续 ${FIELD_VISIT_THRESHOLD} 次失败将提示现场核验）` }
}

// ---- 现场实测录入（两路仲裁的优先数据源） ----

export function submitManualReading(
  pitId: number,
  rawValue: string,
  actorUnit: OwnerUnit,
): ActionOutcome {
  const pit = state.pits.find((p) => p.id === pitId)
  if (!pit) return { ok: false, message: '没有找到该泵坑' }
  const denied = assertOwner(pit, actorUnit, '录入现场读数')
  if (denied) return { ok: false, message: denied }

  const value = parseLevel(rawValue)
  if (value === null) {
    return { ok: false, message: '读数无法识别，已拒绝；空值请走「标记缺数」，不能录成 0' }
  }
  if (isLevelOutOfRange(value, pit.volumeM3)) {
    return { ok: false, message: `现场读数 ${value}m 超出 0~${pit.volumeM3} 合理范围，已拒收，请重新测量` }
  }

  const teleValue = pit.telemetry?.state === 'ok' ? pit.telemetry.value : null
  pit.manual = { value, at: nowText(), state: 'ok', reason: '' }
  // 现场已核实，失败计数清零；遥测本身的健康状态保留给台账对账
  pit.failCount = 0

  let message = `现场实测 ${value.toFixed(2)} m 已录入并作为统一读数`
  if (teleValue !== null && Math.abs(teleValue - value) > 0.05) {
    message += `；与遥测相差 ${Math.abs(teleValue - value).toFixed(2)}m，按现场实测统一，遥测按实测回算，液位计列入待校准`
  }
  commit()
  return { ok: true, message }
}

/** 现场确认液位计确实无读数：显式记缺数，不写 0。 */
export function markMissing(pitId: number, reason: string, actorUnit: OwnerUnit): ActionOutcome {
  const pit = state.pits.find((p) => p.id === pitId)
  if (!pit) return { ok: false, message: '没有找到该泵坑' }
  const denied = assertOwner(pit, actorUnit, '标记缺数')
  if (denied) return { ok: false, message: denied }
  pit.manual = { value: null, at: nowText(), state: 'missing', reason: reason || '现场核实液位计无读数' }
  commit()
  return { ok: true, message: '已标记为缺数并注明原因，未按 0 参与判定' }
}

// ---- 泵组操作 ----

export function setOperational(
  pitId: number,
  next: DrainagePit['operational'],
  actorUnit: OwnerUnit,
): ActionOutcome {
  const pit = state.pits.find((p) => p.id === pitId)
  if (!pit) return { ok: false, message: '没有找到该泵坑' }
  const denied = assertOwner(pit, actorUnit, next === '排水中' ? '启动排水' : next === '水泵故障' ? '上报故障' : '恢复自动')
  if (denied) return { ok: false, message: denied }
  pit.operational = next
  commit()
  return { ok: true, message: next === 'auto' ? '已恢复按水位自动判定' : `泵组状态已更新为「${next}」` }
}

// ---- 现场校准（从其余入口的待查台账关闭异常） ----

export function calibrateGauge(ledgerId: number, actorUnit: OwnerUnit, measuredRaw: string): ActionOutcome {
  const item = state.ledger.find((x) => x.id === ledgerId && x.resolvedAt === null)
  if (!item) return { ok: false, message: '该待查项已闭环或不存在' }
  if (item.ownerUnit !== actorUnit) {
    return { ok: false, message: `已挡回：该液位计归属${item.ownerUnit}，${actorUnit}无权校准` }
  }
  const pit = state.pits.find((p) => p.id === item.pitId)
  if (!pit) return { ok: false, message: '关联泵坑不存在' }

  const measured = parseLevel(measuredRaw)
  if (measured === null) return { ok: false, message: '校准读数无法识别，已拒绝' }
  if (isLevelOutOfRange(measured, pit.volumeM3)) {
    return { ok: false, message: `校准读数 ${measured}m 超出合理范围，已拒收` }
  }

  // 现场校准：以实测更新两路，通道恢复、计数清零
  const ts = nowText()
  pit.manual = { value: measured, at: ts, state: 'ok', reason: '' }
  pit.telemetry = { value: measured, at: ts, state: 'ok', reason: '' }
  pit.failCount = 0
  pit.channel = 'online'
  pit.mockOnlineLevel = measured
  pit.legacyFlag = undefined
  commit()

  // 校准后仍未关闭的同类项强制闭环
  for (const x of state.ledger) {
    if (x.pitId === pit.id && x.resolvedAt === null && ['两路不一致', '读数越界', '疑似断线置零'].includes(x.kind)) {
      x.resolvedAt = ts
      x.resolution = `现场校准完成，两路读数统一为 ${measured.toFixed(2)} m`
    }
  }
  commit()
  return { ok: true, message: `${gaugeCodeOf(pit)} 校准完成，两路读数已统一为 ${measured.toFixed(2)} m` }
}

// ---- 存量迁移：按月份分批 ----

export const migrationBatches = computed(() => {
  const months = [...new Set(state.legacy.map((p) => p.month))].sort()
  return months.map((month) => {
    const items = state.legacy.filter((p) => p.month === month)
    const allDone = items.every((p) => p.migrated)
    return {
      month,
      total: items.length,
      migrated: items.filter((p) => p.migrated).length,
      status: allDone ? ('done' as const) : ('pending' as const),
    }
  })
})

/** 迁移一个月份批次：必须按月份顺序、且整批归属同一操作单位。
 * 早年疑似断线 0 按三条规则识别置空；缺项按上次巡检日期回填并写明出处。 */
export function migrateMonth(month: string, actorUnit: OwnerUnit): ActionOutcome {
  const pendingOlder = migrationBatches.value.some(
    (b) => b.status === 'pending' && b.month < month,
  )
  if (pendingOlder) {
    return { ok: false, message: '需按月份从早到晚分批迁移，请先完成更早的批次' }
  }

  const items = state.legacy.filter((p) => p.month === month && !p.migrated)
  if (!items.length) return { ok: false, message: `${month} 批次已迁移完成` }

  const outsiders = items.filter((p) => p.ownerUnit !== actorUnit)
  if (outsiders.length) {
    return {
      ok: false,
      message: `已挡回：本批次含 ${outsiders.map((p) => `${p.code}（归属${p.ownerUnit}）`).join('、')}，归属之外的迁移操作一律拒绝`,
    }
  }

  for (const legacy of items) {
    const zero = classifyLegacyZero(legacy)
    const latestNote = latestMeasuredInspection(legacy.inspectionNotes)
    const base: DrainagePit = {
      id: 1000 + legacy.id,
      code: legacy.code,
      cabin: legacy.cabin,
      ownerUnit: legacy.ownerUnit,
      volumeM3: legacy.volumeM3,
      startLevelM: legacy.startLevelM,
      pumpCode: legacy.pumpCode,
      duty: legacy.duty,
      lastInspectionDate: legacy.lastInspectionDate,
      telemetry: null,
      manual: null,
      failCount: 0,
      channel: 'online',
      mockOnlineLevel: 0,
      operational: 'auto',
      source: `存量迁移（${month} 批次）`,
    }

    if (zero?.kind === '疑似断线置零') {
      base.legacyFlag = '疑似断线置零'
      base.telemetry = {
        value: null,
        at: `${month}-15 08:00`,
        state: 'missing',
        reason: '存量迁移：早年断线期间误记为 0，已按规则置空',
      }
      base.failCount = 0
      base.remark = zero.detail
    } else if (latestNote && latestNote.measuredLevel !== null) {
      // 缺项回填：按上次巡检日期的现场实测补上，出处写进备注
      base.legacyFlag = zero?.kind === '真零保留' ? '真零保留' : '缺项回填'
      base.manual = {
        value: latestNote.measuredLevel,
        at: latestNote.at,
        state: 'ok',
        reason: '',
      }
      const lastTele = [...legacy.telemetryHistory].sort((a, b) => b.at.localeCompare(a.at))[0]
      base.telemetry =
        lastTele && lastTele.raw !== null
          ? { value: lastTele.raw, at: lastTele.at, state: 'ok', reason: '' }
          : {
              value: null,
              at: latestNote.at,
              state: 'missing',
              reason: `存量迁移：遥测缺项，按上次巡检 ${legacy.lastInspectionDate} 现场记录回填`,
            }
      base.remark =
        zero?.kind === '真零保留'
          ? zero.detail
          : `遥测缺项，按上次巡检日期 ${latestNote.at} 的现场实测回填，出处：巡检记录`
    } else {
      // 遥测缺项、巡检也未量：回填仍为空，备注写清出处，绝不补 0
      base.legacyFlag = '缺项回填'
      base.telemetry = {
        value: null,
        at: `${month}-15 08:00`,
        state: 'missing',
        reason: `存量迁移：遥测缺项，上次巡检 ${legacy.lastInspectionDate} 亦未量水位`,
      }
      base.remark = `两路均无历史读数：遥测缺项，上次巡检 ${legacy.lastInspectionDate} 亦未量水位，出处：遥测档案 + 巡检记录，暂空待现场核`
    }

    base.mockOnlineLevel = base.telemetry?.state === 'ok' ? (base.telemetry.value as number) : 0
    if (!state.pits.some((p) => p.id === base.id)) state.pits.push(base)
    legacy.migrated = true
    legacy.decision = zero?.kind ?? '缺项回填'
    legacy.remark = base.remark
  }

  commit()
  return { ok: true, message: `${month} 批次 ${items.length} 条存量泵坑已迁移，清单与设备台账已同步` }
}

export function legacyRows() {
  return state.legacy
}

export function resetDomain(): void {
  const fresh = buildInitialState()
  state.pits = fresh.pits
  state.ledger = fresh.ledger
  state.legacy = fresh.legacy
  state.nextLedgerId = fresh.nextLedgerId
  state.nextPitId = fresh.nextPitId
  // 清掉镜像进设备台账的液位计行
  const mirrorIds = new Set(fresh.pits.map((p) => gaugeDeviceId(p.id)))
  for (const legacyId of [101, 102, 103, 104]) mirrorIds.add(gaugeDeviceId(1000 + legacyId))
  saveRows('device', listRows('device').filter((row) => !mirrorIds.has(Number(row.id))))
  commit()
}

// 首次加载即对账一次并同步设备台账（保证设备页面打开时液位计已在待校准名单）
commit()
