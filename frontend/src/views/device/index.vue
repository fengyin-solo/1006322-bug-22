<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备台账管理</h2>
        <p class="page-desc">
          排水泵坑液位计的异常结论由排水域自动同步到本台账：列入待校准的液位计与排水清单、待查台账读数一致，不各算各的。
          当前操作单位：<strong>{{ store.unit }}</strong>。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管廊设备</button>
        <button class="btn" type="button" @click="exportRows">导出设备台账清单</button>
      </div>
    </header>

    <section class="gauge-panel">
      <h3>液位计待校准名单（来自排水泵坑异常同步）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>液位计编号</th>
            <th>泵坑</th>
            <th>归属单位</th>
            <th>当前读数</th>
            <th>待校准原因</th>
            <th>结论依据</th>
            <th>现场校准</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in pendingGauges" :key="g.id">
            <td>{{ gaugeOf(g.pitId)?.gaugeCode ?? g.gaugeCode }}</td>
            <td>{{ g.pitCode }}</td>
            <td>{{ g.ownerUnit }}</td>
            <td>
              <template v-if="readingOf(g.pitId) === null">
                <span class="level-missing">暂无</span>
              </template>
              <template v-else>{{ readingOf(g.pitId)?.toFixed(2) }} m</template>
            </td>
            <td><span class="tag tag-warn">{{ g.kind }}</span> {{ g.detail }}</td>
            <td class="cell-reason">{{ g.basis }}</td>
            <td>
              <div class="calibrate-cell">
                <input v-model="calibrateInputs[g.id]" placeholder="校准实测水位(m)" />
                <button
                  class="btn primary"
                  type="button"
                  :disabled="g.ownerUnit !== store.unit"
                  :title="g.ownerUnit === store.unit ? '校准后两路统一' : '非归属单位，操作已拒绝'"
                  @click="doCalibrate(g.id)"
                >校准闭环</button>
              </div>
            </td>
          </tr>
          <tr v-if="!pendingGauges.length">
            <td colspan="7" class="empty-state">暂无待校准液位计，排水侧异常会自动同步到这里</td>
          </tr>
        </tbody>
      </table>
      <p v-if="flash" class="action-flash" :class="flashOk ? 'flash-ok' : 'flash-err'">{{ flash }}</p>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>校准状态 / 读数</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="row['校准结论']" class="tag" :class="row['校准结论'] === '两路一致' ? 'tag-ok' : 'tag-warn'">
              {{ row['校准结论'] }}
            </span>
            <span v-if="row['当前读数']" class="cell-reason">读数：{{ row['当前读数'] }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="isGaugeRow(row)">
              <RouterLink class="link" :to="`/drainage`">去排水侧处理</RouterLink>
            </template>
            <template v-else>
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无设备台账数据，可先登记管廊设备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备记录（含排水域同步的液位计）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'
import { adoptReading, gaugeCodeOf } from '@/drainage/rules'
import { calibrateGauge, pendingCalibrationGauges, pitViews } from '@/drainage/store'

const store = useSessionStore()
const meta = moduleMeta('device')
const columns = ["设备编号", "设备名称", "设备型号", "所属舱室", "投运日期", "保养周期", "上次保养日", "设备状态"]
const actions = ["登记运行", "完成保养", "报废设备"]
const statuses = ["待保养", "运行中", "已保养", "已报废", "待校准"]
const stats = computed(() => [
  { label: "运行中设备", value: rows.value.filter((r) => String(r.status) === '运行中').length },
  { label: "待校准液位计", value: pendingGauges.value.length },
  { label: "已报废设备", value: rows.value.filter((r) => String(r.status) === '已报废').length },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const pendingGauges = pendingCalibrationGauges
const flash = ref('')
const flashOk = ref(false)
const calibrateInputs = reactive<Record<number, string>>({})

function gaugeOf(pitId: number) {
  const v = pitViews.value.find((x) => x.pit.id === pitId)
  return v ? { gaugeCode: gaugeCodeOf(v.pit) } : null
}
function readingOf(pitId: number) {
  return pitViews.value.find((x) => x.pit.id === pitId)?.adopted.value ?? null
}
function isGaugeRow(row: EntryRow) {
  return typeof row['关联泵坑'] === 'string'
}
function doCalibrate(id: number) {
  const r = calibrateGauge(id, store.unit, calibrateInputs[id] ?? '')
  flash.value = r.message
  flashOk.value = r.ok
  if (r.ok) calibrateInputs[id] = ''
  reload()
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管廊设备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    // 液位计镜像行由排水域统一维护状态，加载时以排水域结论为准再对一次
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设备台账列表读取失败'
  }
}

onMounted(reload)
</script>
