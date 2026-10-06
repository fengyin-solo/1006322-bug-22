import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { reconcileDrainage } from './api/drainage-service'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 启动先回算一次：水位结论、清单、设备台账、待校准台账对齐后再挂页面，任何入口读数一致。
reconcileDrainage()
app.mount('#app')
