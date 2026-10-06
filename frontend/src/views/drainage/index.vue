<template>
  <section class="page drainage-page" data-module="drainage">
    <header class="page-head">
      <div>
        <h2>廊内排水运维管理</h2>
        <p class="page-desc">
          取不到当前水位一律显示「暂无」并注明原因，绝不当成 0 米参与启泵判定；真实 0 值正常显示。
          当前操作单位：<strong>{{ store.unit }}</strong>，非归属泵坑的写操作会被直接挡回。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="showRules = !showRules">仲裁 / 识别规则</button>
        <button class="btn ghost" type="button" @click="resetAll">重置演示数据</button>
      </div>
    </header>

    <div v-if="showRules" class="rules-panel">
      <h4>空态、越界与仲裁规则</h4>
      <ol>
        <li><b>空值 ≠ 0：</b>遥测缺数 / 报文非法时当前水位留空显示「暂无」，不参与启泵判定；0 米是合法读数，正常显示「0.00 米」。</li>
        <li><b>重试升级：</b>重试入口每点一次重新取数；连续不足 {{ fieldVisitThreshold }} 次失败只保留重试，达到 {{ fieldVisitThreshold }} 次才提示去现场核；取数恢复或现场录入后失败计数清零。</li>
        <li><b>越界单独提示：</b>启泵水位 ≥ 集水坑容积（登记数值）为「配置越界」；水位超出 0~容积范围为「读数越界」；与缺数互不相混。</li>
        <li><b>两路仲裁：</b>现场实测与遥测差值 &gt; 0.05m 时以现场实测为准统一，遥测按实测回算偏差；现场值越界直接拒收。依据：液位是现场物理量，人工读数贴近真值，遥测受断线 / 漂移影响。</li>
        <li><b>同坑去重：</b>同一泵坑同类未闭环异常只在待查台账记一次，重复上报不新增。</li>
        <li><b>早年「断线写成 0」识别（三条同时命中）：</b>①该 0 仅来自遥测、无现场 0 佐证；②前后相邻读数均非 0 且双向跳变 ≥ 0.5m；③同期通道有故障日志。命中置空并列液位计待校准；有现场 0 佐证的真 0 保留。</li>
        <li><b>存量迁移：</b>上线前台账按数据月份分批、由早到晚迁移；缺项按上次巡检日期的现场记录回填，备注写清出处；巡检也未量的保持空态。</li>
        <li><b>归属管控：</b>跨单位代提交直接挡回，归属之外的重试、录入、校准、迁移一律拒绝；清单、待查台账、设备台账同一事务更新。</li>
      </ol>
    </div>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">在册泵坑</span>
        <strong class="stat-value">{{ views.length }}</strong>
      </article>
      <article class="stat-card stat-warn">
        <span class="stat-label">暂无水位（缺数/非法）</span>
        <strong class="stat-value">{{ missingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待排水</span>
        <strong class="stat-value">{{ pendingDrainCount }}</strong>
      </article>
      <article class="stat-card stat-warn">
        <span class="stat-label">液位计待校准</span>
        <strong class="stat-value">{{ pendingCalibrationGauges.length }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>泵坑编号 / 舱室</span>
        <input v-model="keyword" placeholder="按泵坑编号或舱室检索" />
      </label>
      <label class="filter-item">
        <span>水位状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
    </form>

    <table class="data-table drainage-table">
      <thead>
        <tr>
          <th>泵坑编号</th>
          <th>所属舱室</th>
          <th>归属单位</th>
          <th>集水坑容积(m³)</th>
          <th>当前水位(m)</th>
          <th>启泵水位(m)</th>
          <th>排水泵编号</th>
          <th>当前状态</th>
          <th>异常提示</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="v in filteredViews" :key="v.pit.id" :class="{ 'row-missing': v.adopted.value === null }">
          <td><button class="link" type="button" @click="openDetail(v.pit.id)">{{ v.pit.code }}</button></td>
          <td>{{ v.pit.cabin }}</td>
          <td>
            {{ v.pit.ownerUnit }}
            <span v-if="v.pit.ownerUnit !== store.unit" class="tag tag-muted">非本单位</span>
          </td>
          <td>{{ v.pit.volumeM3 }}</td>
          <td>
            <template v-if="v.adopted.value === null">
              <span class="level-missing">暂无</span>
              <span class="cell-reason">{{ v.adopted.reason }}</span>
            </template>
            <template v-else>
              <span :class="{ 'level-zero': v.pit.telemetry?.value === 0 || v.pit.manual?.value === 0 }">
                {{ v.adopted.value.toFixed(2) }}
              </span>
              <span class="cell-source">（{{ v.adopted.source }}）</span>
              <span v-if="v.adopted.conflict" class="tag tag-warn">两路不一致·按现场</span>
            </template>
          </td>
          <td>
            {{ v.pit.startLevelM }}
            <span v-if="isConfigOutOfRange(v.pit)" class="tag tag-danger">配置越界</span>
          </td>
          <td>{{ v.pit.pumpCode }}</td>
          <td>
            <span :class="statusClass(v.status)">{{ v.status }}</span>
            <span v-if="v.needFieldVisit && v.adopted.value === null" class="tag tag-danger">请去现场核</span>
          </td>
          <td class="anomaly-cell">
            <span v-for="item in v.openLedger" :key="item.id" class="tag tag-warn">{{ item.kind }}</span>
            <span v-if="!v.openLedger.length" class="cell-reason">—</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(v.pit.id)">详情</button>
            <button
              class="link"
              type="button"
              :disabled="!canWrite(v.pit.ownerUnit)"
              :title="canWrite(v.pit.ownerUnit) ? '重新取一次数' : '非归属单位，操作已拒绝'"
              @click="doRetry(v.pit.id)"
            >重试取数</button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td colspan="10" class="empty-state">暂无符合条件的泵坑</td>
        </tr>
      </tbody>
    </table>
    <p class="missing-note">
      说明：标「暂无」的泵坑不参与启泵水位判定，也不会被统计成水位正常；真实 0.00 米与空态在列表、详情、台账三处均可区分。
    </p>

    <section class="ledger-panel">
      <h3>待查台账（异常结论同步设备台账，两边读数一致）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>液位计编号</th>
            <th>泵坑</th>
            <th>归属</th>
            <th>异常类型</th>
            <th>结论与量化说明</th>
            <th>仲裁依据 / 出处</th>
            <th>发现时间</th>
            <th>闭环情况</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ledgerForTable" :key="item.id">
            <td>{{ item.gaugeCode }}</td>
            <td>{{ item.pitCode }}</td>
            <td>{{ item.ownerUnit }}</td>
            <td><span class="tag" :class="kindClass(item.kind)">{{ item.kind }}</span></td>
            <td>{{ item.detail }}</td>
            <td class="basis-cell">{{ item.basis }}<br /><span class="cell-reason">出处：{{ item.source }}</span></td>
            <td>{{ item.openedAt }}</td>
            <td>
              <span v-if="item.resolvedAt" class="tag tag-ok">已闭环 · {{ item.resolution }}</span>
              <span v-else class="tag tag-warn">待查</span>
            </td>
          </tr>
          <tr v-if="!ledgerForTable.length">
            <td colspan="8" class="empty-state">暂无待查异常</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="migration-panel">
      <h3>上线前台账迁移（按月份分批，由早到晚）</h3>
      <div v-for="b in migrationBatches" :key="b.month" class="batch-row">
        <div class="batch-head">
          <strong>{{ b.month }} 批次</strong>
          <span class="cell-reason">共 {{ b.total }} 条，已迁移 {{ b.migrated }} 条</span>
          <span class="tag" :class="b.status === 'done' ? 'tag-ok' : 'tag-warn'">
            {{ b.status === 'done' ? '已完成' : '待迁移' }}
          </span>
          <button
            v-if="b.status === 'pending'"
            class="btn primary"
            type="button"
            @click="doMigrate(b.month)"
          >迁移本批（以{{ store.unit }}身份）</button>
        </div>
        <ul class="legacy-list">
          <li v-for="row in legacyByMonth(b.month)" :key="row.id">
            <span>{{ row.code }} · {{ row.cabin }} · 归属{{ row.ownerUnit }}</span>
            <span v-if="row.migrated" class="tag" :class="decisionClass(row.decision)">
              {{ row.decision }}{{ row.remark ? '：' + row.remark : '' }}
            </span>
            <span v-else class="cell-reason">待迁移</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- 详情面板 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>{{ detail.pit.code }} 详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <div class="detail-grid">
          <div><span class="cell-reason">所属舱室</span>{{ detail.pit.cabin }}</div>
          <div><span class="cell-reason">归属单位</span>{{ detail.pit.ownerUnit }}</div>
          <div><span class="cell-reason">集水坑容积</span>{{ detail.pit.volumeM3 }} m³</div>
          <div>
            <span class="cell-reason">启泵水位</span>{{ detail.pit.startLevelM }} m
            <span v-if="isConfigOutOfRange(detail.pit)" class="tag tag-danger">配置越界：启泵水位≥容积</span>
          </div>
          <div><span class="cell-reason">排水泵</span>{{ detail.pit.pumpCode }}（{{ detail.pit.duty }}）</div>
          <div><span class="cell-reason">上次巡检</span>{{ detail.pit.lastInspectionDate }}</div>
        </div>

        <div class="reading-cards">
          <article class="reading-card">
            <h4>在线遥测（液位计）</h4>
            <template v-if="detail.pit.telemetry?.state === 'ok'">
              <strong :class="{ 'level-zero': detail.pit.telemetry.value === 0 }">
                {{ detail.pit.telemetry.value?.toFixed(2) }} m
              </strong>
            </template>
            <template v-else>
              <strong class="level-missing">暂无</strong>
              <p class="cell-reason">{{ detail.pit.telemetry?.reason || '尚未取数' }}</p>
            </template>
            <p class="cell-reason">{{ detail.pit.telemetry?.at }}</p>
          </article>
          <article class="reading-card">
            <h4>现场实测（人工下井）</h4>
            <template v-if="detail.pit.manual?.state === 'ok'">
              <strong :class="{ 'level-zero': detail.pit.manual.value === 0 }">
                {{ detail.pit.manual.value?.toFixed(2) }} m
              </strong>
            </template>
            <template v-else-if="detail.pit.manual?.state === 'missing'">
              <strong class="level-missing">暂无</strong>
              <p class="cell-reason">{{ detail.pit.manual.reason }}</p>
            </template>
            <template v-else>
              <strong class="cell-reason">未录入</strong>
            </template>
            <p class="cell-reason">{{ detail.pit.manual?.at ?? '—' }}</p>
          </article>
          <article class="reading-card reading-adopted">
            <h4>仲裁后统一读数</h4>
            <strong v-if="detail.adopted.value === null" class="level-missing">暂无（不按 0 判定）</strong>
            <strong v-else>{{ detail.adopted.value.toFixed(2) }} m（{{ detail.adopted.source }}）</strong>
            <p class="cell-reason">{{ detail.adopted.reason }}</p>
            <p v-if="detail.adopted.conflict" class="tag tag-warn">
              遥测按实测回算，偏差 {{ detail.adopted.deviationM?.toFixed(2) }} m
            </p>
          </article>
        </div>

        <div class="detail-actions">
          <button class="btn" type="button" :disabled="!canWrite(detail.pit.ownerUnit)" @click="doRetry(detail.pit.id)">
            重试取数（已连续失败 {{ detail.pit.failCount }} 次）
          </button>
          <button class="btn" type="button" :disabled="!canWrite(detail.pit.ownerUnit)" @click="doStart(detail.pit.id)">启动排水</button>
          <button class="btn" type="button" :disabled="!canWrite(detail.pit.ownerUnit)" @click="doFault(detail.pit.id)">上报水泵故障</button>
          <button class="btn ghost" type="button" :disabled="!canWrite(detail.pit.ownerUnit)" @click="doAuto(detail.pit.id)">恢复自动判定</button>
        </div>
        <p v-if="detail.needFieldVisit && detail.adopted.value === null" class="field-visit">
          已连续 {{ detail.pit.failCount }} 次取不到水位，请安排到现场核验液位计。
        </p>

        <div class="manual-form">
          <h4>现场实测录入 / 标记缺数</h4>
          <div class="manual-row">
            <input v-model="manualInput" placeholder="现场实测水位（米），缺数请留空走标记缺数" />
            <button class="btn primary" type="button" :disabled="!canWrite(detail.pit.ownerUnit)" @click="doSubmitManual">录入实测（优先采信）</button>
            <button class="btn" type="button" :disabled="!canWrite(detail.pit.ownerUnit)" @click="doMarkMissing">确认缺数（留空注明原因）</button>
          </div>
        </div>

        <div class="detail-ledger">
          <h4>待查台账（同步至设备台账）</h4>
          <table class="data-table">
            <tbody>
              <tr v-for="item in detail.openLedger" :key="item.id">
                <td style="width:110px"><span class="tag" :class="kindClass(item.kind)">{{ item.kind }}</span></td>
                <td>{{ item.detail }}</td>
                <td class="cell-reason">{{ item.basis }}</td>
                <td style="width:150px">
                  <input
                    v-if="calibratable(item.kind)"
                    v-model="calibrateInputs[item.id]"
                    class="calibrate-input"
                    placeholder="校准实测水位(m)"
                  />
                  <button
                    v-if="calibratable(item.kind)"
                    class="link"
                    type="button"
                    :disabled="!canWrite(detail.pit.ownerUnit)"
                    @click="doCalibrate(item.id)"
                  >现场校准并闭环</button>
                </td>
              </tr>
              <tr v-if="!detail.openLedger.length"><td colspan="4" class="empty-state">无未闭环异常</td></tr>
            </tbody>
          </table>
        </div>

        <p v-if="flash" class="action-flash" :class="flashOk ? 'flash-ok' : 'flash-err'">{{ flash }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { useSessionStore } from '@/stores/session'
import { isConfigOutOfRange, FIELD_VISIT_THRESHOLD } from '@/drainage/rules'
import {
  allLedgerItems,
  calibrateGauge,
  legacyRows,
  markMissing,
  migrateMonth,
  migrationBatches,
  openLedgerOf,
  pendingCalibrationGauges,
  pitViews,
  resetDomain,
  retryFetch,
  setOperational,
  submitManualReading,
} from '@/drainage/store'
import type { AnomalyKind, OwnerUnit } from '@/drainage/types'

const store = useSessionStore()
const fieldVisitThreshold = FIELD_VISIT_THRESHOLD

const keyword = ref('')
const statusFilter = ref('')
const showRules = ref(false)
const statusOptions = ['水位正常', '待排水', '排水中', '暂无数据', '水泵故障']

const views = pitViews
const missingCount = computed(() => views.value.filter((v) => v.adopted.value === null).length)
const pendingDrainCount = computed(() => views.value.filter((v) => v.status === '待排水').length)

const filteredViews = computed(() =>
  views.value.filter((v) => {
    const kw = keyword.value.trim()
    const hitKw = !kw || v.pit.code.includes(kw) || v.pit.cabin.includes(kw)
    const hitStatus = !statusFilter.value || v.status === statusFilter.value
    return hitKw && hitStatus
  }),
)

const ledgerForTable = computed(() =>
  [...allLedgerItems.value].sort(
    (a, b) => Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null),
  ),
)

function legacyByMonth(month: string) {
  return legacyRows().filter((row) => row.month === month)
}

function decisionClass(decision?: string) {
  if (decision === '真零保留') return 'tag-ok'
  if (decision === '疑似断线置零') return 'tag-danger'
  return 'tag-warn'
}

function kindClass(kind: AnomalyKind) {
  if (kind === '配置越界' || kind === '读数越界' || kind === '疑似断线置零') return 'tag-danger'
  return 'tag-warn'
}

function statusClass(status: string) {
  if (status === '水位正常') return 'tag tag-ok'
  if (status === '待排水') return 'tag tag-warn'
  if (status === '暂无数据') return 'tag tag-danger'
  return 'tag'
}

function canWrite(owner: OwnerUnit) {
  return owner === store.unit
}

const calibrateInputs = reactive<Record<number, string>>({})
function calibratable(kind: AnomalyKind) {
  return ['两路不一致', '读数越界', '疑似断线置零'].includes(kind)
}
function doCalibrate(ledgerId: number) {
  const r = calibrateGauge(ledgerId, store.unit, calibrateInputs[ledgerId] ?? '')
  notify(r.ok, r.message)
}

// ---- 详情 ----
const detailId = ref<number | null>(null)
const detail = computed(() => {
  if (detailId.value === null) return null
  const v = views.value.find((x) => x.pit.id === detailId.value)
  if (!v) return null
  return { ...v, openLedger: openLedgerOf(v.pit.id) }
})
const manualInput = ref('')
const flash = ref('')
const flashOk = ref(false)

function openDetail(id: number) {
  detailId.value = id
  manualInput.value = ''
  flash.value = ''
}
function closeDetail() {
  detailId.value = null
}

function notify(ok: boolean, message: string) {
  flash.value = message
  flashOk.value = ok
}

function doRetry(id: number) {
  const r = retryFetch(id, store.unit)
  if (detailId.value === id) notify(r.ok, r.message)
}
function doSubmitManual() {
  if (!detail.value) return
  const r = submitManualReading(detail.value.pit.id, manualInput.value, store.unit)
  notify(r.ok, r.message)
  if (r.ok) manualInput.value = ''
}
function doMarkMissing() {
  if (!detail.value) return
  const r = markMissing(detail.value.pit.id, '现场核验：液位计无有效读数', store.unit)
  notify(r.ok, r.message)
}
function doStart(id: number) {
  const r = setOperational(id, '排水中', store.unit)
  if (detailId.value === id) notify(r.ok, r.message)
}
function doFault(id: number) {
  const r = setOperational(id, '水泵故障', store.unit)
  if (detailId.value === id) notify(r.ok, r.message)
}
function doAuto(id: number) {
  const r = setOperational(id, 'auto', store.unit)
  if (detailId.value === id) notify(r.ok, r.message)
}

function doMigrate(month: string) {
  const r = migrateMonth(month, store.unit)
  window.alert(r.message)
}

function resetAll() {
  resetDomain()
  window.alert('排水域演示数据与设备台账镜像已重置')
}
</script>
