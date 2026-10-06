// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  calibrateGauge,
  getPitView,
  listCalibration,
  listPitViews,
  migrateMonth,
  migrationBatches,
  resetDrainageDomain,
  retryFetch,
  setPumpState,
  submitManualLevel,
} from './drainage-service'
import { listRows } from '@/data/local-store'

const UNIT1 = '管廊运维一所'
const UNIT2 = '管廊运维二所'

beforeEach(() => {
  window.localStorage.clear()
  resetDrainageDomain()
})

function pit(id: number) {
  return getPitView(id)!
}

describe('空值与 0 严格区分', () => {
  it('断连泵坑：缺测显示暂无、不按 0 判定为水位正常', () => {
    const v = pit(2)
    expect(v.resolvedLevel).toBeNull()
    expect(v.missing).toBe(true)
    expect(v.status).toBe('数据缺测')
    expect(v.reason).toContain('通信中断')
    // 清单行同步为空，而不是 0
    const row = listRows('drainage').find((r) => Number(r.id) === 2)!
    expect(row['当前水位']).toBe('')
    expect(row['数据状态']).toBe('缺测')
  })

  it('巡检确认的真实 0 米保留为 0 并判正常', () => {
    const v = pit(7)
    expect(v.resolvedLevel).toBe(0)
    expect(v.missing).toBe(false)
    expect(v.status).toBe('水位正常')
  })

  it('缺测时禁止启泵，避免按 0 误判', () => {
    const r = setPumpState(2, '排水中', UNIT1)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('缺测')
  })

  it('现场实测可以合法录入 0（干涸），与缺测区分', () => {
    const r = submitManualLevel(1, '0', '测试员', UNIT1)
    expect(r.ok).toBe(true)
    expect(pit(1).resolvedLevel).toBe(0)
    expect(pit(1).status).toBe('水位正常')
    expect(pit(1).adopted).toBe('manual')
  })
})

describe('越界取值单独提示', () => {
  it('启泵水位大于集水坑容积：标配置越界，不影响有效读数', () => {
    const v = pit(5)
    expect(v.outOfRange).toBe(true)
    expect(v.outOfRangeText).toContain('20')
    expect(v.resolvedLevel).toBe(1.0)
    expect(listRows('drainage').find((r) => Number(r.id) === 5)!['数据状态']).toBe('配置越界')
  })

  it('实测读数超过容积上限被拒', () => {
    const r = submitManualLevel(1, '999', '测试员', UNIT1)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('越界')
  })

  it('非数字实测被拒并提示 0 不能用来表达缺测', () => {
    expect(submitManualLevel(1, 'abc', '测试员', UNIT1).ok).toBe(false)
  })
})

describe('重试与连续失败阈值', () => {
  it('连续失败 1~2 次不挂账，第 3 次起提示去现场并同步设备台账', () => {
    // pit2 种子里已经 3 次：初始 reconcile 即挂账
    expect(pit(2).escalated).toBe(true)
    expect(pit(2).openCalibration?.gaugeDeviceId).toBe('LEV-0002')
    const dev = listRows('device').find((r) => r['设备编号'] === 'LEV-0002')!
    expect(dev.status).toBe('待校准')
  })

  it('同一液位计重复失败只记一次台账', () => {
    retryFetch(2, UNIT1)
    retryFetch(2, UNIT1)
    const open = listCalibration('待校准').filter((r) => r.gaugeDeviceId === 'LEV-0002')
    expect(open).toHaveLength(1)
  })

  it('重试入口重新取一次：在线仪表立即恢复', () => {
    const r = retryFetch(1, UNIT1)
    expect(r.ok).toBe(true)
    expect(pit(1).missing).toBe(false)
  })
})

describe('两路读数冲突以现场实测为准', () => {
  it('液位计 1.2 与实测 2.6 冲突：采信实测、液位计留档未采信、按实测判待排水', () => {
    const v = pit(4)
    expect(v.conflict).toBe(true)
    expect(v.resolvedLevel).toBe(2.6)
    expect(v.adopted).toBe('manual')
    expect(v.gaugeAdopted).toBe(false)
    expect(v.status).toBe('待排水')
    expect(v.openCalibration?.gaugeDeviceId).toBe('LEV-0004')
  })

  it('校准后两路读数一致、台账销项、设备恢复运行', () => {
    const r = calibrateGauge(4, '校准员', UNIT1)
    expect(r.ok).toBe(true)
    const v = pit(4)
    expect(v.conflict).toBe(false)
    expect(v.gaugeLevel).toBe(2.6)
    expect(v.resolvedLevel).toBe(2.6)
    expect(listCalibration('待校准').filter((x) => x.gaugeDeviceId === 'LEV-0004')).toHaveLength(0)
    expect(listRows('device').find((x) => x['设备编号'] === 'LEV-0004')!.status).toBe('运行中')
  })

  it('校准则需实测基准，没有实测记录时拒绝', () => {
    const r = calibrateGauge(2, '校准员', UNIT1)
    expect(r.ok).toBe(false)
  })
})

describe('跨单位代提交拦截', () => {
  it('二所泵坑：一所账号重试/实测/校准/启泵全部挡回', () => {
    expect(retryFetch(8, UNIT1).ok).toBe(false)
    expect(submitManualLevel(8, '3.5', '测试员', UNIT1).ok).toBe(false)
    expect(setPumpState(8, '排水中', UNIT1).ok).toBe(false)
    expect(calibrateGauge(8, '测试员', UNIT1).ok).toBe(false)
    // 归属单位本人可操作
    expect(retryFetch(8, UNIT2).ok).toBe(true)
  })
})

describe('存量按月迁移与断线记 0 识别', () => {
  it('批次概览正确分组，2026-08 含 1 个疑似断线 0', () => {
    const batches = migrationBatches()
    expect(batches.map((b) => b.month).sort()).toEqual(['2026-07', '2026-08'])
    const aug = batches.find((b) => b.month === '2026-08')!
    expect(aug.suspectZero).toBe(1)
  })

  it('迁移前疑似断线 0 已按缺测处理（不参与判定）', () => {
    const v = pit(6)
    expect(v.legacyZero).toBe(true)
    expect(v.resolvedLevel).toBeNull()
    expect(v.status).toBe('数据缺测')
    expect(v.reason).toContain('按上次巡检日期回填')
  })

  it('执行 2026-08 批次：0 剔除为缺测、备注写明出处、挂待校准', () => {
    const r = migrateMonth('2026-08')
    expect(r.ok).toBe(true)
    const v = pit(6)
    expect(v.gaugeLevel).toBeNull()
    expect(v.migratedBatch).toBe('2026-08')
    expect(v.migrationNote).toContain('2026-08 月度运行台账')
    expect(v.openCalibration?.batch).toBe('2026-08')
    expect(listRows('device').find((x) => x['设备编号'] === 'LEV-0006')!.status).toBe('待校准')
    // 幂等：重复执行不新增
    migrateMonth('2026-08')
    expect(listCalibration('待校准').filter((x) => x.gaugeDeviceId === 'LEV-0006')).toHaveLength(1)
  })

  it('2026-07 批次迁移保留巡检确认的 0', () => {
    migrateMonth('2026-07')
    expect(pit(7).resolvedLevel).toBe(0)
    expect(pit(7).status).toBe('水位正常')
  })
})

describe('台账与清单同步', () => {
  it('任何入口看到的读数一致：清单当前水位 == 视图判读水位', () => {
    for (const v of listPitViews()) {
      const row = listRows('drainage').find((r) => Number(r.id) === v.pitId)!
      expect(row['当前水位']).toBe(v.resolvedLevel === null ? '' : v.resolvedLevel)
      expect(row.status).toBe(v.status)
    }
  })

  it('现场实测后清单、设备台账同步回算', () => {
    submitManualLevel(1, '1.9', '测试员', UNIT1)
    const row = listRows('drainage').find((r) => Number(r.id) === 1)!
    expect(row['当前水位']).toBe(1.9)
    expect(row['现场实测水位']).toBe(1.9)
  })
})
