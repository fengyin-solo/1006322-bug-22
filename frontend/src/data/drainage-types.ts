/**
 * 排水泵坑水位领域模型。
 *
 * 关键约定：
 * - 水位一律用 number | null 表达：null 是「取不到数」，0 是「实测干涸」，二者永不混同。
 * - 判定状态由遥测数据实时回算，清单不保存独立结论，避免台账与清单各算各的。
 */

/** 泵组运行态（值班操作），与水位判读互相独立。 */
export type PumpState = '自动' | '排水中' | '水泵故障'

/** 仲裁后采信的取值来源。 */
export type LevelSource = 'gauge' | 'manual'

/** 液位计校准台账记录（设备入口与排水入口共用同一份）。 */
export interface CalibrationRecord {
  id: number
  /** 液位计设备编号，同一只液位计的待校准记录只允许有一条。 */
  gaugeDeviceId: string
  pitId: number
  pitCode: string
  ownerUnit: string
  /** 列入原因：连续取数失败 / 两路读数冲突。 */
  reason: string
  openedAt: string
  state: '待校准' | '已校准'
  consecutiveFails: number
  calibratedAt: string | null
  /** 备注：出处、批次、校准依据都落在这里。 */
  basis: string
  /** 由哪个月份的存量迁移批次挂账，在线异常为 null。 */
  batch: string | null
}

/**
 * 单个泵坑的水位遥测与处置痕迹。清单行（EntryRow）里的当前水位、状态
 * 全部由这份数据回算，不允许反向手工写清单。
 */
export interface DrainageTelemetry {
  pitId: number
  /** 液位计设备编号，对应设备台账里的设备编号。 */
  gaugeDeviceId: string
  ownerUnit: string

  // —— 上线前存量与迁移 ——
  /** 是否上线前台账。 */
  legacy: boolean
  /** 上线前台账所属月份（YYYY-MM），迁移按此分批。 */
  dataMonth: string | null
  /** 疑似早年把断线写成 0：识别出来后、迁移之前就先按缺测处理。 */
  legacyZero: boolean
  migratedBatch: string | null
  migrationNote: string
  /** 上次巡检日期：存量泵坑缺数时按它回填「数据截止」。 */
  inspectDate: string

  // —— 配置 ——
  /** 集水坑容积（m³，数值比较时作为配置上限）。 */
  capacity: number | null
  /** 启泵水位（m）。 */
  pumpOnLevel: number | null
  pumpState: PumpState

  // —— 液位计一路（自动取值 + 取数过程） ——
  /** 液位计是否在线。断连期间重试只会继续失败，校准后恢复。 */
  gaugeHealthy: boolean
  /** 模拟液位计真值的演示字段；换后端时删除。 */
  simulatedLevel: number
  gaugeLevel: number | null
  gaugeOk: boolean
  failReason: string
  consecutiveFails: number
  lastFetchAt: string | null

  // —— 现场实测一路（人工取值） ——
  manualLevel: number | null
  manualAt: string | null
  manualBy: string | null

  /** 仲裁结论：当前采信哪一路；null 表示两路都无数。 */
  adopted: LevelSource | null
}

/** 列表/详情统一消费的视图模型，由 service 回算，页面不自行判断。 */
export interface PitView {
  pitId: number
  code: string
  cabin: string
  ownerUnit: string
  pumpNo: string
  duty: string
  gaugeDeviceId: string

  capacity: number | null
  pumpOnLevel: number | null
  pumpState: PumpState

  gaugeLevel: number | null
  gaugeOk: boolean
  gaugeAdopted: boolean
  failReason: string
  fails: number
  lastFetchAt: string | null
  escalated: boolean

  manualLevel: number | null
  manualAt: string | null
  manualBy: string | null

  /** 仲裁后用于判定的水位；null 即缺数据，任何地方都不得拿它当 0。 */
  resolvedLevel: number | null
  adopted: LevelSource | null
  conflict: boolean
  conflictText: string

  /** 配置越界（如启泵水位大于集水坑容积）。 */
  outOfRange: boolean
  outOfRangeText: string
  /** 读数本身越界（负值或超过容积上限）。 */
  readingOutOfRange: boolean

  missing: boolean
  /** 缺测/存量缺项给页面交代的缘由。 */
  reason: string

  legacy: boolean
  /** 疑似早年断线被记成 0。 */
  legacyZero: boolean
  dataMonth: string | null
  migratedBatch: string | null
  migrationNote: string
  inspectDate: string

  status: string
  abnormal: boolean
  openCalibration: CalibrationRecord | null
}

/** 月份迁移批次的概览。 */
export interface MigrationBatchInfo {
  month: string
  total: number
  migrated: number
  /** 疑似断线记 0，本批会剔除为缺测。 */
  suspectZero: number
  /** 出处不可考，只能留待人工补录。 */
  unverifiable: number
  genuineZero: number
  normalCount: number
}
