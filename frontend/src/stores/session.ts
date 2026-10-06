import { defineStore } from 'pinia'

export type OwnerUnit = '运营中心' | '第一运维所' | '第二运维所'

export const OWNER_UNITS: OwnerUnit[] = ['运营中心', '第一运维所', '第二运维所']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
    // 当前操作单位：只允许对归属本单位的泵坑 / 液位计执行写操作
    unit: '第一运维所' as OwnerUnit,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setUnit(unit: OwnerUnit) {
      this.unit = unit
    },
  },
})
