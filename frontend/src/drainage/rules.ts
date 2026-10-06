import type {
  AnomalyKind,
  DrainagePit,
  GaugeReading,
  LedgerItem,
  LegacyInspectionNote,
  LegacyPit,
  LegacyTelemetryPoint,
} from './types'

/** 现场实测与遥测的差值阈值（米）：超过即认定两路不一致，按现场实测统一。 */
export const CONFLICT_TOLERANCE_M = 0.05
/** 连续取不到这么多次，才提示去现场核；之前只给重试入口。 */
export const FIELD_VISIT_THRESHOLD = 3

/** 解析读数：空串 / null / 非数字 → null（绝不退化成 0）。 */
export function parseLevel(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

/** 启泵水位配置越界：启泵水位（米）≥ 集水坑容积（登记数值层面比较，同条记录取值）。
 * 按需求约定「启泵水位比集水坑容积还大」直接比登记数值，越界单独提示。 */
export function isConfigOutOfRange(pit: Pick<DrainagePit, 'startLevelM' | 'volumeM3'>): boolean {
  return pit.startLevelM >= pit.volumeM3
}

/** 读数越界：水位不能超过集水坑容积（登记数值层面），负值同样非法。 */
export function isLevelOutOfRange(value: number | null, volumeM3: number): boolean {
  if (value === null) return false
  return value < 0 || value > volumeM3
}

export interface AdoptedReading {
  value: number | null
  /** 统一采用的数据来源 */
  source: '现场实测' | '在线遥测' | null
  state: 'ok' | 'missing' | 'invalid'
  /** 两路是否同时有数且差值超差 */
  conflict: boolean
  /** 偏差量（米），冲突时回算遥测误差用 */
  deviationM: number | null
  reason: string
}

/** 两路取值仲裁：
 * 1) 两路互不相同时（差值 > 0.05m），以现场实测为准，遥测按实测回算偏差；
 *    依据：液位是现场物理量，人工下井读数直接贴近真值，遥测受断线、漂移影响；
 * 2) 只有遥测有数 → 用遥测；都没有 → 暂无（null），不以 0 充数；
 * 3) 现场实测若越界（超容积 / 为负）视为录入错误，当场拒收并提示，绝不覆盖。 */
export function adoptReading(pit: DrainagePit): AdoptedReading {
  const tele = pit.telemetry
  const manual = pit.manual

  if (manual && manual.state === 'ok' && isLevelOutOfRange(manual.value, pit.volumeM3)) {
    // 越界的现场值不参与仲裁：保留原遥测，提示重新测量
    return {
      value: tele && tele.state === 'ok' ? tele.value : null,
      source: tele && tele.state === 'ok' ? '在线遥测' : null,
      state: tele?.state === 'ok' ? 'ok' : tele?.state === 'invalid' ? 'invalid' : 'missing',
      conflict: false,
      deviationM: null,
      reason: `现场实测 ${manual.value}m 超出集水坑容积 ${pit.volumeM3}，已拒收，请重新测量`,
    }
  }

  const teleOk = tele && tele.state === 'ok' && !isLevelOutOfRange(tele.value, pit.volumeM3)
  const manualOk = manual && manual.state === 'ok'

  if (manualOk && teleOk) {
    const deviation = Math.abs((manual.value as number) - (tele.value as number))
    if (deviation > CONFLICT_TOLERANCE_M) {
      return {
        value: manual.value,
        source: '现场实测',
        state: 'ok',
        conflict: true,
        deviationM: deviation,
        reason: `两路相差 ${deviation.toFixed(2)}m，按现场实测统一，遥测按实测回算`,
      }
    }
    return {
      value: manual.value,
      source: '现场实测',
      state: 'ok',
      conflict: false,
      deviationM: null,
      reason: '两路读数一致',
    }
  }

  if (manualOk) {
    return {
      value: manual.value,
      source: '现场实测',
      state: 'ok',
      conflict: false,
      deviationM: null,
      reason: tele ? '遥测缺数，暂以现场实测为准' : '现场实测',
    }
  }

  if (teleOk) {
    return {
      value: tele.value,
      source: '在线遥测',
      state: 'ok',
      conflict: false,
      deviationM: null,
      reason: manual ? '现场读数缺失，暂以在线遥测为准' : '在线遥测',
    }
  }

  // 两路都不可用：空就是空，不用 0 顶替
  const invalidOne = [tele, manual].find((r) => r && r.state === 'invalid')
  return {
    value: null,
    source: null,
    state: invalidOne ? 'invalid' : 'missing',
    conflict: false,
    deviationM: null,
    reason: invalidOne
      ? `液位数据报文非法：${invalidOne.reason}`
      : `取不到当前水位（${[tele, manual].map((r) => r?.reason).filter(Boolean).join('；') || '两路均无数据'}）`,
  }
}

export type LevelStatus =
  | '水位正常'
  | '待排水'
  | '排水中'
  | '暂无数据'
  | '水泵故障'

/** 统一状态判定：缺数 / 非法一律落到「暂无数据」，绝不判成水位正常。 */
export function deriveStatus(pit: DrainagePit, adopted: AdoptedReading): LevelStatus {
  if (pit.operational === '排水中') return '排水中'
  if (pit.operational === '水泵故障') return '水泵故障'
  if (adopted.value === null) return '暂无数据'
  if (isConfigOutOfRange(pit)) {
    // 配置越界不影响水位显示，但启泵判定失去意义：能比较时仍给出高低，这里按未越界逻辑给出
  }
  return adopted.value >= pit.startLevelM ? '待排水' : '水位正常'
}

/** 当前应在待查台账中保持打开的异常结论（同一泵坑同类异常只记一次，靠 kind 去重）。 */
export function evaluateAnomalies(pit: DrainagePit, adopted: AdoptedReading): { kind: AnomalyKind; detail: string; basis: string }[] {
  const out: { kind: AnomalyKind; detail: string; basis: string }[] = []

  // 存量迁移判定的「疑似断线置零」单独进台账，由现场校准关闭
  if (pit.legacyFlag === '疑似断线置零') {
    out.push({
      kind: '疑似断线置零',
      detail: `存量迁移识别出早年断线期间被写成 0 的记录，已置空：${pit.remark ?? ''}`,
      basis: '遥测 0 与两侧非 0 读数双向跳变≥0.5m、同期通道有故障日志且无现场 0 佐证，待现场校准液位计',
    })
  }

  if (adopted.value === null || pit.failCount > 0) {
    const teleState = pit.telemetry?.state
    if ((teleState === 'missing' || teleState === 'invalid') && pit.legacyFlag !== '疑似断线置零') {
      out.push({
        kind: '取数失败',
        detail: `连续 ${pit.failCount} 次取不到水位：${pit.telemetry?.reason ?? '液位计无响应'}`,
        basis: '遥测缺数，不参与水位判定，现场核实前不采信任何 0 值',
      })
    } else if (!pit.manual && adopted.value === null) {
      out.push({
        kind: '取数失败',
        detail: `两路均取不到水位，已连续失败 ${pit.failCount} 次`,
        basis: '空值留空，不以 0 参与启泵判定',
      })
    }
  }

  if (isConfigOutOfRange(pit)) {
    out.push({
      kind: '配置越界',
      detail: `启泵水位 ${pit.startLevelM}m 大于等于集水坑容积对应量 ${pit.volumeM3}，启泵阈值配置无效`,
      basis: '同一条泵坑登记记录内取值比较，越界与缺数分开提示',
    })
  }

  const teleValue = pit.telemetry?.state === 'ok' ? pit.telemetry.value : null
  if (teleValue !== null && isLevelOutOfRange(teleValue, pit.volumeM3)) {
    out.push({
      kind: '读数越界',
      detail: `遥测水位 ${teleValue}m 超出 0~${pit.volumeM3} 合理范围，疑似液位计量程漂移`,
      basis: '读数越界单独标记，不四舍五入为 0，也不覆盖现场值',
    })
  }

  if (adopted.conflict && adopted.deviationM !== null) {
    out.push({
      kind: '两路不一致',
      detail: `遥测 ${teleValue}m 与现场实测 ${pit.manual?.value}m 相差 ${adopted.deviationM.toFixed(2)}m`,
      basis: `液位为现场物理量，现场实测优先；遥测按实测回算偏差 ${adopted.deviationM.toFixed(2)}m，液位计列待校准`,
    })
  }

  return out
}

/** 把当前应打开的异常与台账做对账：新开的补记（同坑同类未闭环不重复记），
 * 已消除的关闭。取数失败在遥测恢复健康时自动关闭；其余以现场校准 / 处置为准。 */
export function reconcileLedger(
  pit: DrainagePit,
  ledger: LedgerItem[],
  adopted: AdoptedReading,
  now: string,
): LedgerItem[] {
  const wanted = evaluateAnomalies(pit, adopted)
  const next = ledger.map((item) => ({ ...item }))

  for (const want of wanted) {
    const open = next.find((item) => item.pitId === pit.id && item.kind === want.kind && item.resolvedAt === null)
    if (open) {
      // 已存在同类未闭环：结论刷新，不重复记
      open.detail = want.detail
      open.basis = want.basis
      continue
    }
    next.push({
      id: -1, // 由 store 分配
      pitId: pit.id,
      pitCode: pit.code,
      gaugeCode: gaugeCodeOf(pit),
      ownerUnit: pit.ownerUnit,
      kind: want.kind,
      detail: want.detail,
      basis: want.basis,
      source: adopted.source ?? pit.source ?? '在线遥测',
      openedAt: now,
      resolvedAt: null,
      reporterUnit: pit.ownerUnit,
    })
  }

  // 关闭已消除的异常
  for (const item of next) {
    if (item.pitId !== pit.id || item.resolvedAt !== null) continue
    const stillOpen = wanted.some((want) => want.kind === item.kind)
    if (!stillOpen) {
      item.resolvedAt = now
      item.resolution =
        item.kind === '取数失败'
          ? '遥测恢复取数，读数在合理范围内'
          : item.kind === '两路不一致'
            ? '液位计现场校准完成，两路读数一致'
            : item.kind === '读数越界'
              ? '液位计校准后读数回到量程内'
              : '配置 / 现场处置完成'
    }
  }
  return next
}

export function gaugeCodeOf(pit: Pick<DrainagePit, 'code'>): string {
  return `LEVEL-${pit.code.slice(-4)}`
}

/** 液位计在设备台账中的稳定编号（local-store 的 device 模块镜像行 id）。 */
export function gaugeDeviceId(pitId: number): number {
  return 9000 + pitId
}

// ---- 存量迁移：早年把断线数据写成 0 的识别 ----

export type LegacyZeroDecision =
  | { kind: '疑似断线置零'; at: string; detail: string }
  | { kind: '真零保留'; at: string; detail: string }
  | { kind: '缺项回填'; at: string; detail: string }
  | { kind: '无历史' }

/** 识别规则（三条同时命中才认定为「断线写成 0」，从严避免误删真实 0）：
 * ① 该 0 只来自遥测，同期巡检没有现场实测为 0 的佐证；
 * ② 前后相邻读数两侧均非 0，且双向跳变都 ≥ 0.5m（V 形尖底，不符合水位连续性）；
 * ③ 该时刻同期通道存在故障 / 超时日志。
 * 命中 → 置空（不再是 0），液位计进待校准台账；
 * 未命中但有现场 0 佐证 → 真实 0 保留，备注写明出处。 */
export function classifyLegacyZero(p: LegacyPit): Extract<LegacyZeroDecision, { at: string }> | null {
  const hist = [...p.telemetryHistory].sort((a, b) => a.at.localeCompare(b.at))
  let suspect: Extract<LegacyZeroDecision, { at: string }> | null = null
  for (let i = 0; i < hist.length; i++) {
    const point = hist[i]
    if (point.raw !== 0) continue
    const note = p.inspectionNotes.find((n) => n.at.slice(0, 10) === point.at.slice(0, 10))
    const hasManualZeroProof = note && note.measuredLevel === 0

    // 有同日现场 0 佐证：真实 0，优先且立即采信
    if (hasManualZeroProof) {
      return {
        kind: '真零保留',
        at: point.at,
        detail: `${point.at} 遥测为 0，同日巡检现场实测同为 0m，判定为真实 0 值，保留并注明出处`,
      }
    }

    if (suspect) continue
    const prev = hist[i - 1]
    const next = hist[i + 1]
    if (!prev || !next || prev.raw === null || next.raw === null) continue

    const drop = prev.raw - point.raw // 0 处跌落幅度
    const rise = next.raw - point.raw // 0 处回升幅度
    const vShape = drop >= 0.5 && rise >= 0.5

    if (vShape && point.channelIncident) {
      suspect = {
        kind: '疑似断线置零',
        at: point.at,
        detail: `${point.at} 遥测为 0：前点 ${prev.raw}m、后点 ${next.raw}m 双向跳变均≥0.5m，且同期通道有故障日志，无现场 0 值佐证，判定断线误记，置空`,
      }
    }
  }
  return suspect
}

/** 找最近一次有量的现场巡检记录，作为缺项回填日期。 */
export function latestMeasuredInspection(notes: LegacyInspectionNote[]): LegacyInspectionNote | null {
  const measured = notes.filter((n) => n.measuredLevel !== null)
  if (!measured.length) return null
  return [...measured].sort((a, b) => b.at.localeCompare(a.at))[0]
}

export type { GaugeReading, LegacyTelemetryPoint }
