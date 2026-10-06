// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'

import DrainagePage from './index.vue'

beforeEach(() => {
  window.localStorage.clear()
  setActivePinia(createPinia())
})

describe('排水页面渲染', () => {
  it('挂载后列出泵坑，缺测泵坑显示「暂无」而不是 0', async () => {
    const wrapper = mount(DrainagePage)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('DRAI-0002')
    expect(text).toContain('暂无')
    expect(text).toContain('通信中断')
    expect(text).toContain('启泵水位 20m 大于集水坑容积')
    expect(text).toContain('2026-08')
  })

  it('重试跨单位泵坑被挡回并给出提示', async () => {
    const wrapper = mount(DrainagePage)
    await flushPromises()
    const rows = wrapper.findAll('tbody tr')
    const target = rows.find((r) => r.text().includes('DRAI-0008'))!
    const retryBtn = target.findAll('button').find((b) => b.text() === '重试取数')!
    await retryBtn.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('跨单位代提交已拦截')
  })
})
