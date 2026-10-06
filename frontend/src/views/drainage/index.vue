<template>
  <section class="page" data-module="drainage">
    <header class="page-head">
      <div>
        <h2>廊内排水运维管理</h2>
        <p class="page-desc">
          泵坑水位按「液位计 + 现场实测」两路取值：取不到数显示「暂无」并说明原因，绝不按 0 米参与判定；
          两路读数冲突时以现场实测为准。当前操作账号归属：<strong>{{ store.unit }}</strong>，归属之外的操作一律拒绝。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排水泵坑</button>
        <button class="btn" type="button" @click="exportRows">导出廊内排水运维清单</button>
        <button class="btn ghost" type="button" @click="resetDemo">恢复演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item" :class="item.cls">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 上线前台账按月份分批迁移 -->
    <section v-if="batches.length" class="migration-panel">
      <header class="panel-head">
        <h3>上线前台账迁移（按月份分批）</h3>
        <span class="panel-tip">早年缺项出处写入备注；疑似断线记 0 的记录迁移时剔除为缺测并挂待校准</span>
      </header>
      <table class="data-table mini">
        <thead>
          <tr>
            <th>月份批次</th><th>泵坑数</th><th>已迁移</th><th>疑似断线记0</th><th>出处不可考</th><th>巡检确认干涸</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in batches" :key="b.month">
            <td>{{ b.month }}</td>
            <td>{{ b.total }}</td>
            <td>{{ b.migrated }} / {{ b.total }}</td>
            <td :class="{ 'cell-warn': b.suspectZero }">{{ b.suspectZero }}</td>
            <td :class="{ 'cell-warn': b.unverifiable }">{{ b.unverifiable }}</td>
            <td>{{ b.genuineZero }}</td>
            <td>
              <button v-if="b.migrated < b.total" class="link" type="button" @click="doMigrate(b.month)">
                迁移 {{ b.month }} 批次
              </button>
              <span v-else class="ok-text">已完成</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>泵坑编号</span>
        <input v-model="keyword" placeholder="按泵坑编号/舱室检索" />
      </label>
      <label class="filter-item">
        <span>数据状态</span>
        <select v-model="stateFilter">
          <option value="">全部</option>
          <option value="missing">仅看缺测</option>
          <option value="outOfRange">仅看配置越界</option>
          <option value="conflict">仅看两路冲突</option>
          <option value="pendingCal">仅看待校准</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>泵坑编号</th>
          <th>所属舱室</th>
          <th>归属单位</th>
          <th>集水坑容积(m³)</th>
          <th>当前水位判定</th>
          <th>液位计读数(m)</th>
          <th>现场实测(m)</th>
          <th>启泵水位(m)</th>
          <th>泵组状态</th>
          <th>判读结论</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="v in filteredViews" :key="v.pitId" :class="{ 'row-abnormal': v.abnormal }">
          <td>
            <button class="link" type="button" @click="openDetail(v)">{{ v.code }}</button>
            <span v-if="v.legacy" class="tag tag-muted">存量{{ v.dataMonth }}</span>
          </td>
          <td>{{ v.cabin }}</td>
          <td>{{ v.ownerUnit }}</td>
          <td>{{ v.capacity ?? '暂无' }}</td>
          <td>
            <template v-if="v.resolvedLevel === null">
              <span class="missing-cell">暂无</span>
              <p class="cell-reason">{{ v.reason }}</p>
            </template>
            <template v-else>
              <strong :class="{ zero: v.resolvedLevel === 0 }">{{ v.resolvedLevel.toFixed(2) }}</strong>
              <span class="tag" :class="v.adopted === 'manual' ? 'tag-manual' : 'tag-gauge'">
                {{ v.adopted === 'manual' ? '现场实测' : '液位计' }}
              </span>
              <p v-if="v.resolvedLevel === 0" class="cell-reason ok-text">实测干涸（0 为真实读数，非缺测）</p>
            </template>
          </td>
          <td>
            <span v-if="v.gaugeLevel === null" class="missing-text">取不到</span>
            <span v-else :class="{ rejected: v.conflict }">{{ v.gaugeLevel.toFixed(2) }}</span>
            <p v-if="v.conflict" class="cell-reason">未采信</p>
          </td>
          <td>
            <span v-if="v.manualLevel === null" class="muted-text">—</span>
            <span v-else>{{ v.manualLevel.toFixed(2) }}</span>
          </td>
          <td>
            <span :class="{ 'cell-warn': v.outOfRange }">{{ v.pumpOnLevel ?? '暂无' }}</span>
            <p v-if="v.outOfRange" class="cell-reason">{{ v.outOfRangeText }}</p>
          </td>
          <td>{{ v.pumpState }}</td>
          <td>
            <span class="status-badge" :class="statusClass(v)">{{ v.status }}</span>
            <p v-if="v.escalated" class="cell-warn">已连续取不到 {{ v.fails }} 次，请去现场核</p>
            <p v-if="v.openCalibration" class="cell-warn">液位计已列入设备侧待校准</p>
            <p v-if="v.conflict" class="cell-reason">{{ v.conflictText }}</p>
            <p v-if="v.migratedBatch" class="cell-reason">已随 {{ v.migratedBatch }} 批次迁移</p>
          </td>
          <td class="row-actions vertical">
            <button class="link" type="button" @click="openDetail(v)">详情</button>
            <button class="link" type="button" @click="doRetry(v)">重试取数</button>
            <button class="link" type="button" @click="openManual(v)">现场实测</button>
            <button
              class="link"
              type="button"
              :disabled="!v.openCalibration || v.ownerUnit !== store.unit"
              :title="v.ownerUnit !== store.unit ? '非归属单位，无权校准' : ''"
              @click="doCalibrate(v)"
            >校准液位计</button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td colspan="11" class="empty-state">没有符合条件的排水泵坑记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ views.length }} 个泵坑 · 数据保存在本机浏览器</span>
      <span v-if="message" class="foot-msg" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 详情面板 -->
    <div v-if="detail" class="drawer-mask" @click.self="detail = null">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>{{ detail.code }} 水位详情</h3>
          <button class="btn ghost" type="button" @click="detail = null">关闭</button>
        </header>

        <div class="detail-block">
          <h4>基本信息</h4>
          <dl class="detail-grid">
            <div><dt>所属舱室</dt><dd>{{ detail.cabin }}</dd></div>
            <div><dt>归属单位</dt><dd>{{ detail.ownerUnit }}</dd></div>
            <div><dt>排水泵编号</dt><dd>{{ detail.pumpNo }}</dd></div>
            <div><dt>值班人员</dt><dd>{{ detail.duty }}</dd></div>
            <div><dt>集水坑容积</dt><dd>{{ detail.capacity ?? '暂无' }} m³</dd></div>
            <div><dt>启泵水位</dt><dd :class="{ 'cell-warn': detail.outOfRange }">{{ detail.pumpOnLevel ?? '暂无' }} m</dd></div>
            <div><dt>液位计编号</dt><dd>{{ detail.gaugeDeviceId }}</dd></div>
            <div><dt>上次巡检日期</dt><dd>{{ detail.inspectDate || '暂无（存量缺项）' }}</dd></div>
          </dl>
        </div>

        <div class="detail-block">
          <h4>两路取值与仲裁</h4>
          <dl class="detail-grid">
            <div>
              <dt>液位计读数</dt>
              <dd v-if="detail.gaugeLevel === null" class="missing-text">暂无（取数失败）</dd>
              <dd v-else :class="{ rejected: detail.conflict }">
                {{ detail.gaugeLevel.toFixed(2) }} m
                <span v-if="detail.conflict" class="tag tag-warn">未采信</span>
                <span v-else-if="detail.gaugeAdopted" class="tag tag-gauge">采信</span>
              </dd>
            </div>
            <div>
              <dt>现场实测</dt>
              <dd v-if="detail.manualLevel === null" class="muted-text">暂无</dd>
              <dd v-else>
                {{ detail.manualLevel.toFixed(2) }} m
                <span v-if="detail.adopted === 'manual'" class="tag tag-manual">采信</span>
                <small class="muted-text">（{{ detail.manualBy }} · {{ detail.manualAt }}）</small>
              </dd>
            </div>
            <div>
              <dt>判读水位</dt>
              <dd v-if="detail.resolvedLevel === null" class="missing-text">暂无，不参与判定</dd>
              <dd v-else><strong>{{ detail.resolvedLevel.toFixed(2) }} m</strong>（{{ detail.adopted === 'manual' ? '按现场实测' : '按液位计' }}）</dd>
            </div>
            <div><dt>判读结论</dt><dd><span class="status-badge" :class="statusClass(detail)">{{ detail.status }}</span></dd></div>
          </dl>
          <p v-if="detail.conflict" class="detail-note warn">{{ detail.conflictText }}</p>
          <p v-if="detail.outOfRange" class="detail-note warn">{{ detail.outOfRangeText }}</p>
          <p v-if="detail.readingOutOfRange" class="detail-note warn">液位计读数超出物理量程，按缺测处理，不当 0</p>
        </div>

        <div class="detail-block">
          <h4>取数过程</h4>
          <dl class="detail-grid">
            <div><dt>最近取数</dt><dd>{{ detail.lastFetchAt ?? '暂无' }}</dd></div>
            <div><dt>连续失败</dt><dd :class="{ 'cell-warn': detail.fails > 0 }">{{ detail.fails }} 次（达 {{ threshold }} 次提示去现场核）</dd></div>
            <div><dt>失败原因</dt><dd>{{ detail.failReason || '—' }}</dd></div>
          </dl>
          <p v-if="detail.missing" class="detail-note warn">缺测说明：{{ detail.reason }}</p>
          <p v-else-if="detail.resolvedLevel === 0" class="detail-note ok">当前 0 米为真实读数（干涸），与缺测严格区分。</p>
        </div>

        <div v-if="detail.legacy" class="detail-block">
          <h4>存量与迁移</h4>
          <dl class="detail-grid">
            <div><dt>台账月份</dt><dd>{{ detail.dataMonth }}</dd></div>
            <div><dt>迁移批次</dt><dd>{{ detail.migratedBatch ?? '待迁移' }}</dd></div>
          </dl>
          <p class="detail-note">备注/出处：{{ detail.migrationNote || '暂无' }}</p>
        </div>

        <div class="detail-block">
          <h4>设备侧待校准台账（两边读数一致）</h4>
          <p v-if="!detail.openCalibration" class="muted-text">该液位计没有挂起的待校准记录。</p>
          <table v-else class="data-table mini">
            <tbody>
              <tr><th>液位计编号</th><td>{{ detail.openCalibration.gaugeDeviceId }}</td></tr>
              <tr><th>列入原因</th><td>{{ detail.openCalibration.reason }}</td></tr>
              <tr><th>挂账时间</th><td>{{ detail.openCalibration.openedAt }}</td></tr>
              <tr><th>批次</th><td>{{ detail.openCalibration.batch ?? '在线异常' }}</td></tr>
              <tr><th>依据</th><td>{{ detail.openCalibration.basis }}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="detail-actions">
          <button class="btn" type="button" :disabled="detail.ownerUnit !== store.unit" @click="doRetry(detail)">
            重试取数
          </button>
          <button class="btn" type="button" :disabled="detail.ownerUnit !== store.unit" @click="openManual(detail)">
            登记现场实测
          </button>
          <button class="btn primary" type="button" :disabled="!detail.openCalibration || detail.ownerUnit !== store.unit" @click="openCalibrate(detail)">
            现场校准
          </button>
          <button class="btn" type="button" :disabled="detail.ownerUnit !== store.unit" @click="doPump(detail, '排水中')">
            启动排水
          </button>
          <button class="btn ghost" type="button" :disabled="detail.ownerUnit !== store.unit" @click="doPump(detail, '自动')">
            停泵转自动
          </button>
        </div>
        <p v-if="detail.ownerUnit !== store.unit" class="detail-note warn">
          跨单位代提交直接挡回：当前账号归属「{{ store.unit }}」，该泵坑归属「{{ detail.ownerUnit }}」。
        </p>
      </aside>
    </div>

    <!-- 现场实测录入 -->
    <div v-if="manualTarget" class="drawer-mask" @click.self="manualTarget = null">
      <aside class="drawer narrow">
        <header class="drawer-head"><h3>登记现场实测水位 · {{ manualTarget.code }}</h3><button class="btn ghost" type="button" @click="manualTarget = null">关闭</button></header>
        <p class="panel-tip">现场实测是直接量，与液位计读数冲突时一律以本读数为准并回算全部结论。干涸请填 0；取不到就留空，不要填 0。</p>
        <form class="manual-form" @submit.prevent="submitManual">
          <label>
            <span>实测水位（m，0 ~ {{ manualTarget.capacity ?? '容积上限' }}）</span>
            <input v-model="manualValue" type="number" step="0.01" placeholder="例如 2.6；干涸填 0" />
          </label>
          <label>
            <span>实测人</span>
            <input v-model="manualOperator" placeholder="默认当前值班人" />
          </label>
          <button class="btn primary" type="submit">提交实测</button>
        </form>
      </aside>
    </div>

    <!-- 现场校准录入 -->
    <div v-if="calibrateTarget" class="drawer-mask" @click.self="calibrateTarget = null">
      <aside class="drawer narrow">
        <header class="drawer-head"><h3>现场校准液位计 · {{ calibrateTarget.gaugeDeviceId }}</h3><button class="btn ghost" type="button" @click="calibrateTarget = null">关闭</button></header>
        <p class="panel-tip">校准以现场实测为基准，校完两路读数一致并从待校准台账销项。</p>
        <form class="manual-form" @submit.prevent="submitCalibrate">
          <label>
            <span>校准基准水位（m）</span>
            <input v-model="calibrateValue" type="number" step="0.01" :placeholder="calibrateTarget.manualLevel !== null ? `沿用最近实测 ${calibrateTarget.manualLevel}m，可留空` : '必填，干涸填 0'" />
          </label>
          <button class="btn primary" type="submit">完成校准</button>
        </form>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  calibrateGauge,
  failThreshold,
  listCalibration,
  listPitViews,
  migrateMonth,
  migrationBatches,
  resetDrainageDomain,
  retryFetch,
  setPumpState,
  submitManualLevel,
} from '@/api/drainage-service'
import { useSessionStore } from '@/stores/session'
import type { MigrationBatchInfo, PitView } from '@/data/drainage-types'

const store = useSessionStore()
const threshold = failThreshold()

const views = ref<PitView[]>([])
const keyword = ref('')
const stateFilter = ref('')
const message = ref('')
const messageOk = ref(true)

const detail = ref<PitView | null>(null)
const manualTarget = ref<PitView | null>(null)
const manualValue = ref('')
const manualOperator = ref(store.operator)
const calibrateTarget = ref<PitView | null>(null)
const calibrateValue = ref('')
const batches = ref<MigrationBatchInfo[]>([])

const stats = computed(() => [
  { label: '泵坑总数', value: views.value.length, warn: false },
  { label: '水位缺测（留空·非0）', value: views.value.filter((v) => v.missing).length, warn: true },
  { label: '配置越界', value: views.value.filter((v) => v.outOfRange).length, warn: true },
  { label: '两路冲突·采信实测', value: views.value.filter((v) => v.conflict).length, warn: true },
  { label: '液位计待校准', value: listCalibration('待校准').length, warn: true },
  { label: '待排水', value: views.value.filter((v) => v.status === '待排水').length, warn: false },
])

const LEGEND: { status: string; cls: string }[] = [
  { status: '水位正常', cls: 'ok' },
  { status: '待排水', cls: '' },
  { status: '排水中', cls: '' },
  { status: '数据缺测', cls: 'missing' },
  { status: '水泵故障', cls: 'bad' },
]

const statusSummary = computed(() =>
  LEGEND.map((item) => ({
    ...item,
    count: views.value.filter((v) => v.status === item.status).length,
  })),
)

const filteredViews = computed(() => {
  const kw = keyword.value.trim()
  return views.value.filter((v) => {
    if (kw && !v.code.includes(kw) && !v.cabin.includes(kw)) return false
    if (stateFilter.value === 'missing' && !v.missing) return false
    if (stateFilter.value === 'outOfRange' && !v.outOfRange) return false
    if (stateFilter.value === 'conflict' && !v.conflict) return false
    if (stateFilter.value === 'pendingCal' && !v.openCalibration) return false
    return true
  })
})

function flash(text: string, ok = true) {
  message.value = text
  messageOk.value = ok
}

function statusClass(v: PitView): string {
  if (v.status === '数据缺测') return 'st-missing'
  if (v.status === '水泵故障') return 'st-bad'
  if (v.status === '待排水' || v.status === '排水中') return 'st-warn'
  return 'st-ok'
}

function reload() {
  views.value = listPitViews()
  const all = migrationBatches()
  batches.value = [...all.filter((b) => b.migrated < b.total), ...all.filter((b) => b.migrated >= b.total)]
  if (detail.value) {
    const updated = views.value.find((v) => v.pitId === detail.value?.pitId)
    detail.value = updated ?? null
  }
}

function resetFilters() {
  keyword.value = ''
  stateFilter.value = ''
}

function exportRows() {
  downloadEntries('drainage')
}

function openCreate() {
  flash('排水泵坑登记入口尚未接入审批流', false)
}

function resetDemo() {
  resetDrainageDomain()
  reload()
  flash('已恢复排水演示数据（清单、遥测、校准台账同步重置）')
}

function openDetail(v: PitView) {
  detail.value = v
}

function doRetry(v: PitView) {
  const r = retryFetch(v.pitId, store.unit)
  flash(r.message, r.ok)
  reload()
}

function openManual(v: PitView) {
  if (v.ownerUnit !== store.unit) {
    flash(`跨单位代提交直接挡回：该泵坑归属「${v.ownerUnit}」，当前账号归属「${store.unit}」`, false)
    return
  }
  manualTarget.value = v
  manualValue.value = v.manualLevel !== null ? String(v.manualLevel) : ''
  manualOperator.value = store.operator
}

function submitManual() {
  if (!manualTarget.value) return
  const r = submitManualLevel(
    manualTarget.value.pitId,
    manualValue.value,
    manualOperator.value.trim() || store.operator,
    store.unit,
  )
  flash(r.message, r.ok)
  if (r.ok) {
    manualTarget.value = null
    reload()
  }
}

function doCalibrate(v: PitView) {
  // 列表上的快捷校准：沿用最近实测，没有实测则要求进面板录入
  const r = calibrateGauge(v.pitId, store.operator, store.unit)
  flash(r.message, r.ok)
  reload()
}

function openCalibrate(v: PitView) {
  calibrateTarget.value = v
  calibrateValue.value = v.manualLevel !== null ? '' : ''
}

function submitCalibrate() {
  if (!calibrateTarget.value) return
  const r = calibrateGauge(
    calibrateTarget.value.pitId,
    store.operator,
    store.unit,
    calibrateValue.value,
  )
  flash(r.message, r.ok)
  if (r.ok) {
    calibrateTarget.value = null
    reload()
  }
}

function doPump(v: PitView, next: PitView['pumpState']) {
  const r = setPumpState(v.pitId, next, store.unit)
  flash(r.message, r.ok)
  reload()
}

function doMigrate(month: string) {
  const r = migrateMonth(month)
  flash(r.message, r.ok)
  reload()
}

onMounted(reload)
</script>
