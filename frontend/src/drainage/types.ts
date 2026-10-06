/** 排水泵坑域的专用模型。
 * 与通用台账（EntryRow）分开：水位读数必须携带「正常 / 缺数 / 非法」状态，
 * 缺数留空（null），绝不允许写成 0 再参与启泵判定。 */

/** 归属单位：跨单位代提交一律挡回，只有归属单位能写。 */
export type OwnerUnit = '运营中心' | '第一运维所' | '第二运维所'

/** 一次水位读数的可信状态。null 值与数字 0 在这里被严格区分。 */
export interface GaugeReading {
  /** 米；取不到 / 报文非法时为 null，页面显示「暂无」而不是 0 */
  value: number | null
  /** 取数时刻（YYYY-MM-DD HH:mm） */
  at: string
  state: 'ok' | 'missing' | 'invalid'
  /** 缺数或非法的具体原因，页面原样交代给值班人员 */
  reason: string
}

/** 排水泵坑（在用量）。 */
export interface DrainagePit {
  id: number
  code: string
  cabin: string
  ownerUnit: OwnerUnit
  /** 集水坑容积（m³，登记值） */
  volumeM3: number
  /** 启泵水位（m，配置值） */
  startLevelM: number
  pumpCode: string
  duty: string
  /** 上次巡检日期：存量缺项按这一天的巡检记录回填 */
  lastInspectionDate: string

  /** 遥测通道读数（液位计自动上报） */
  telemetry: GaugeReading | null
  /** 现场实测读数（人工下井核验），存在时仲裁优先于遥测 */
  manual: GaugeReading | null
  /** 遥测连续取数失败（含报文非法）次数；成功或现场录入后清零 */
  failCount: number
  /** 纯前端演示用通道：offline 持续断线；flaky 第三次取数恢复；online 正常 */
  channel: 'online' | 'offline' | 'flaky'
  /** 通道恢复后返回的稳定读数，便于演示确定性 */
  mockOnlineLevel: number

  /** 人工操作的泵组状态；auto 表示跟随水位自动判定 */
  operational: 'auto' | '排水中' | '水泵故障'

  /** 数据出处 / 迁移备注，随记录长期保留 */
  source: string
  remark?: string
  /** 由存量迁移转入时的历史判定，迁移前档案无此标记 */
  legacyFlag?: '疑似断线置零' | '缺项回填' | '真零保留'
}

/** 异常类型：缺数、越界、冲突互不混同，各自单独提示。 */
export type AnomalyKind =
  | '取数失败'
  | '配置越界'
  | '读数越界'
  | '两路不一致'
  | '疑似断线置零'

/** 待查台账条目：排水清单与设备台账共用这一份结论，两边读数永远一致。 */
export interface LedgerItem {
  id: number
  pitId: number
  pitCode: string
  /** 液位计编号，与设备台账镜像行一一对应 */
  gaugeCode: string
  ownerUnit: OwnerUnit
  kind: AnomalyKind
  /** 异常结论（含越界量、偏差量等量化说明） */
  detail: string
  /** 仲裁依据：为什么采用这一份读数 */
  basis: string
  /** 出处：在线遥测 / 现场实测 / 巡检记录 / 存量迁移 */
  source: string
  openedAt: string
  resolvedAt: string | null
  resolution?: string
  reporterUnit: OwnerUnit
}

/** 一条历史读数（早年遥测档案）。 */
export interface LegacyTelemetryPoint {
  at: string
  /** 原始入库值；null 表示当时就缺项 */
  raw: number | null
  /** 同期通道是否有故障 / 超时日志（疑似断线置零的识别要件之一） */
  channelIncident: boolean
}

/** 一条巡检现场记录。 */
export interface LegacyInspectionNote {
  at: string
  /** 现场实测水位；null 表示该次巡检未量水位 */
  measuredLevel: number | null
}

/** 存量泵坑：上线前待迁移的历史档案，按数据月份分批。 */
export interface LegacyPit {
  id: number
  code: string
  cabin: string
  ownerUnit: OwnerUnit
  volumeM3: number
  startLevelM: number
  pumpCode: string
  duty: string
  lastInspectionDate: string
  /** 归属数据月份（YYYY-MM），迁移批次即月份 */
  month: string
  telemetryHistory: LegacyTelemetryPoint[]
  inspectionNotes: LegacyInspectionNote[]
  migrated: boolean
  /** 迁移判定结论 */
  decision?: string
  remark?: string
}

export interface MigrationBatch {
  month: string
  status: 'pending' | 'done'
  migratedAt: string | null
  total: number
}

export interface DrainageState {
  version: number
  pits: DrainagePit[]
  ledger: LedgerItem[]
  legacy: LegacyPit[]
  nextLedgerId: number
  nextPitId: number
}
