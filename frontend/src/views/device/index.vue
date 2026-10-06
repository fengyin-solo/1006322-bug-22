<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备台账管理</h2>
        <p class="page-desc">
          维护管廊设备与排水泵坑液位计校准台账。排水侧连续取数失败 / 两路读数冲突的液位计会自动列入待校准，
          两处台账同源更新、读数一致。当前操作账号归属：<strong>{{ store.unit }}</strong>。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管廊设备</button>
        <button class="btn" type="button" @click="exportRows">导出设备台账管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 液位计待校准台账：排水异常结论回写过来，同一份记录 -->
    <section class="migration-panel">
      <header class="panel-head">
        <h3>液位计待校准台账（与廊内排水运维同源）</h3>
        <span class="panel-tip">同一液位计只挂一条；同一泵坑重复上报不重复记录。校准后两边读数一致并销项。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>液位计编号</th><th>关联泵坑</th><th>归属单位</th><th>列入原因</th>
            <th>液位计读数</th><th>当前采信</th><th>批次</th><th>挂账时间</th><th>依据</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rec in openCalibrations" :key="rec.id" class="row-abnormal">
            <td>{{ rec.gaugeDeviceId }}</td>
            <td>{{ rec.pitCode }}</td>
            <td>{{ rec.ownerUnit }}</td>
            <td>{{ rec.reason }}</td>
            <td>
              <span v-if="pitOf(rec.pitId)?.gaugeLevel === null" class="missing-text">取不到</span>
              <span v-else :class="{ rejected: pitOf(rec.pitId)?.conflict }">
                {{ pitOf(rec.pitId)?.gaugeLevel?.toFixed(2) ?? '—' }}
              </span>
            </td>
            <td>
              <template v-if="pitOf(rec.pitId)?.resolvedLevel === null">
                <span class="missing-text">暂无·不按0判定</span>
              </template>
              <template v-else>
                {{ pitOf(rec.pitId)?.resolvedLevel?.toFixed(2) }}
                <span class="tag" :class="pitOf(rec.pitId)?.adopted === 'manual' ? 'tag-manual' : 'tag-gauge'">
                  {{ pitOf(rec.pitId)?.adopted === 'manual' ? '现场实测' : '液位计' }}
                </span>
              </template>
            </td>
            <td>{{ rec.batch ?? '在线异常' }}</td>
            <td>{{ rec.openedAt }}</td>
            <td class="basis-cell">{{ rec.basis }}</td>
            <td class="row-actions vertical">
              <button
                class="link"
                type="button"
                :disabled="rec.ownerUnit !== store.unit"
                :title="rec.ownerUnit !== store.unit ? '非归属单位，无权校准' : ''"
                @click="quickCalibrate(rec.pitId)"
              >现场校准</button>
            </td>
          </tr>
          <tr v-if="!openCalibrations.length">
            <td colspan="10" class="empty-state">暂无待校准液位计</td>
          </tr>
        </tbody>
      </table>
      <p v-if="doneCalibrations.length" class="panel-tip">
        近期已校准销项 {{ doneCalibrations.length }} 只：
        <span v-for="rec in doneCalibrations" :key="rec.id" class="tag tag-gauge">
          {{ rec.gaugeDeviceId }}（{{ rec.calibratedAt }}）
        </span>
      </p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>设备编号</span>
        <input v-model="keyword" placeholder="按设备编号/名称检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="keyword = ''">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设备台账数据，可先登记管廊设备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { calibrateGauge, getPitView, listCalibration } from '@/api/drainage-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'
import type { PitView } from '@/data/drainage-types'

const store = useSessionStore()
const meta = moduleMeta('device')
const columns = ["设备编号", "设备名称", "设备型号", "所属舱室", "投运日期", "保养周期", "上次保养日", "设备状态"]
const actions = ["登记运行", "完成保养", "报废设备"]
const statuses = ["待保养", "运行中", "已保养", "待校准", "已报废"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const keyword = ref('')

const openCalibrations = computed(() => listCalibration('待校准'))
const doneCalibrations = computed(() => listCalibration('已校准'))
const pitCache = ref<Map<number, PitView>>(new Map())

const stats = computed(() => [
  { label: '设备总数', value: rows.value.length, warn: false },
  { label: '运行中', value: rows.value.filter((r) => r.status === '运行中').length, warn: false },
  { label: '液位计待校准', value: openCalibrations.value.length, warn: true },
  { label: '今日已校准销项', value: doneCalibrations.value.length, warn: false },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const filteredRows = computed(() => {
  const kw = keyword.value.trim()
  if (!kw) return rows.value
  return rows.value.filter((r) => String(r['设备编号']).includes(kw) || String(r['设备名称']).includes(kw))
})

function pitOf(pitId: number): PitView | undefined {
  return pitCache.value.get(pitId)
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

function quickCalibrate(pitId: number) {
  const pit = getPitView(pitId)
  // 设备侧校准要求带回现场实测基准；已有最近实测可直接沿用，否则必须当场录入
  let basis: string | undefined
  if (pit?.manualLevel === null || pit?.manualLevel === undefined) {
    const input = window.prompt('请输入现场实测基准水位（m，干涸填 0）：')
    if (input === null) return
    basis = input
  }
  const result = calibrateGauge(pitId, store.operator, store.unit, basis)
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 先触发排水侧回算同步，设备台账行的「待校准」状态由领域服务统一写
    const payload = listEntries(meta.key, {})
    rows.value = payload.items
    total.value = payload.total
    const cache = new Map<number, PitView>()
    for (const rec of listCalibration()) {
      const v = getPitView(rec.pitId)
      if (v) cache.set(rec.pitId, v)
    }
    pitCache.value = cache
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设备台账读取失败'
  }
}

onMounted(reload)
</script>
