import { defineStore } from 'pinia'

// 归属单位用于拦截跨单位代提交：演示里可切换，泵坑归属之外的操作一律拒绝。
export const UNITS = ['管廊运维一所', '管廊运维二所'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    unit: UNITS[0] as string,
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setUnit(unit: string) {
      this.unit = unit
    },
  },
})
